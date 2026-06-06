package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const datasetSampleLimit = 64 * 1024

var datasetUploadLocks sync.Map

type datasetUploadState struct {
	ID          string `json:"id"`
	DatasetID   string `json:"dataset_id"`
	LabID       string `json:"lab_id,omitempty"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Length      int64  `json:"length"`
	Offset      int64  `json:"offset"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

func datasetRoot() string {
	home := os.Getenv("HOME")
	if home == "" {
		home = "."
	}
	return filepath.Join(home, "datasets")
}

func uploadRoot() string {
	return filepath.Join(datasetRoot(), ".uploads")
}

func bearerOrQueryToken(r *http.Request) string {
	if tok := r.URL.Query().Get("token"); tok != "" {
		return tok
	}
	ah := r.Header.Get("Authorization")
	if strings.HasPrefix(ah, "Bearer ") {
		return strings.TrimPrefix(ah, "Bearer ")
	}
	return ""
}

func requireBrokerAuth(w http.ResponseWriter, r *http.Request) bool {
	expected := brokerToken()
	if expected == "" {
		jsonError(w, http.StatusInternalServerError, "broker_token_unset",
			"BROKER_TENANT_TOKEN is not set on this machine")
		return false
	}
	if !constantTimeStringEq(bearerOrQueryToken(r), expected) {
		jsonError(w, http.StatusUnauthorized, "invalid_token",
			"missing or invalid token")
		return false
	}
	return requireTenantID(w)
}

func randomID(prefix string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b[:]), nil
}

func safeDatasetFilename(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "upload.bin", nil
	}
	if raw != filepath.Base(raw) || strings.Contains(raw, `\`) {
		return "", errors.New("filename must not contain path separators")
	}
	if raw == "." || raw == ".." || strings.HasPrefix(raw, ".") {
		return "", errors.New("filename is not allowed")
	}
	return raw, nil
}

func parseUploadMetadata(raw string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, val, _ := strings.Cut(part, " ")
		if decoded, err := base64.StdEncoding.DecodeString(val); err == nil {
			val = string(decoded)
		}
		out[key] = val
	}
	return out
}

func newDatasetUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only POST is allowed on /datasets/uploads")
		return
	}
	if !requireBrokerAuth(w, r) {
		return
	}
	length := int64(-1)
	if raw := r.Header.Get("Upload-Length"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			jsonError(w, http.StatusBadRequest, "invalid_upload_length",
				"Upload-Length must be a non-negative integer")
			return
		}
		length = n
	}
	metadata := parseUploadMetadata(r.Header.Get("Upload-Metadata"))
	filename, err := safeDatasetFilename(metadata["filename"])
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid_filename", err.Error())
		return
	}
	if ct := strings.TrimSpace(r.Header.Get("Content-Type")); ct != "" {
		mediatype, _, err := mime.ParseMediaType(ct)
		if err == nil {
			ct = mediatype
		}
		metadata["content_type"] = ct
	}
	uploadID, err := randomID("upl_")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "id_generation_failed", err.Error())
		return
	}
	datasetID, err := randomID("ds_")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "id_generation_failed", err.Error())
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	state := datasetUploadState{
		ID:          uploadID,
		DatasetID:   datasetID,
		LabID:       strings.TrimSpace(metadata["lab_id"]),
		Filename:    filename,
		ContentType: metadata["content_type"],
		Length:      length,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := os.MkdirAll(uploadRoot(), 0o700); err != nil {
		jsonError(w, http.StatusInternalServerError, "upload_state_failed", err.Error())
		return
	}
	if err := writeUploadState(state); err != nil {
		jsonError(w, http.StatusInternalServerError, "upload_state_failed", err.Error())
		return
	}
	w.Header().Set("Tus-Resumable", "1.0.0")
	w.Header().Set("Upload-Offset", "0")
	w.Header().Set("Location", "/datasets/uploads/"+uploadID)
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"upload_id":  uploadID,
		"dataset_id": datasetID,
	})
}

func uploadStatePath(id string) string {
	return filepath.Join(uploadRoot(), id+".json")
}

func uploadDataPath(id string) string {
	return filepath.Join(uploadRoot(), id+".part")
}

func datasetUploadLock(id string) *sync.Mutex {
	lock, _ := datasetUploadLocks.LoadOrStore(id, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func validUploadID(id string) bool {
	if !strings.HasPrefix(id, "upl_") || len(id) != 36 {
		return false
	}
	for _, ch := range strings.TrimPrefix(id, "upl_") {
		if !((ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9')) {
			return false
		}
	}
	return true
}

func readUploadState(id string) (datasetUploadState, error) {
	if !validUploadID(id) {
		return datasetUploadState{}, os.ErrNotExist
	}
	b, err := os.ReadFile(uploadStatePath(id))
	if err != nil {
		return datasetUploadState{}, err
	}
	var state datasetUploadState
	if err := json.Unmarshal(b, &state); err != nil {
		return datasetUploadState{}, err
	}
	return state, nil
}

func writeUploadState(state datasetUploadState) error {
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	tmp := uploadStatePath(state.ID) + ".tmp"
	b, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := syncFile(tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, uploadStatePath(state.ID)); err != nil {
		return err
	}
	return syncDir(uploadRoot())
}

func datasetUploadByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/datasets/uploads/")
	id, action, _ := strings.Cut(id, "/")
	if !requireBrokerAuth(w, r) {
		return
	}
	switch {
	case r.Method == http.MethodHead && action == "":
		headDatasetUpload(w, id)
	case r.Method == http.MethodPatch && action == "":
		patchDatasetUpload(w, r, id)
	case r.Method == http.MethodPost && action == "finalize":
		finalizeDatasetUpload(w, r, id)
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"unsupported dataset upload method")
	}
}

func finalizedDatasets(w http.ResponseWriter, r *http.Request) {
	if !requireBrokerAuth(w, r) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		listFinalizedDatasets(w, r)
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only GET is allowed on /datasets")
	}
}

func finalizedDatasetByID(w http.ResponseWriter, r *http.Request) {
	if !requireBrokerAuth(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only GET is allowed on /datasets/{dataset_id}")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/datasets/")
	if strings.Contains(id, "/") {
		jsonError(w, http.StatusNotFound, "dataset_not_found", "dataset not found")
		return
	}
	meta, err := readDatasetMeta(id)
	if err != nil {
		jsonError(w, http.StatusNotFound, "dataset_not_found", "dataset not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(meta)
}

func headDatasetUpload(w http.ResponseWriter, id string) {
	state, err := readUploadState(id)
	if err != nil {
		jsonError(w, http.StatusNotFound, "upload_not_found", "upload not found")
		return
	}
	w.Header().Set("Tus-Resumable", "1.0.0")
	w.Header().Set("Upload-Offset", strconv.FormatInt(state.Offset, 10))
	if state.Length >= 0 {
		w.Header().Set("Upload-Length", strconv.FormatInt(state.Length, 10))
	}
	w.WriteHeader(http.StatusNoContent)
}

func patchDatasetUpload(w http.ResponseWriter, r *http.Request, id string) {
	lock := datasetUploadLock(id)
	lock.Lock()
	defer lock.Unlock()

	state, err := readUploadState(id)
	if err != nil {
		jsonError(w, http.StatusNotFound, "upload_not_found", "upload not found")
		return
	}
	got, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if err != nil || got < 0 {
		jsonError(w, http.StatusBadRequest, "invalid_upload_offset",
			"Upload-Offset must be a non-negative integer")
		return
	}
	if got != state.Offset {
		jsonError(w, http.StatusConflict, "offset_mismatch",
			fmt.Sprintf("expected Upload-Offset %d", state.Offset))
		return
	}
	f, err := os.OpenFile(uploadDataPath(id), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "upload_append_failed", err.Error())
		return
	}
	if err := f.Truncate(state.Offset); err != nil {
		_ = f.Close()
		jsonError(w, http.StatusInternalServerError, "upload_append_failed", err.Error())
		return
	}
	reader := io.Reader(r.Body)
	remaining := int64(-1)
	if state.Length >= 0 {
		remaining = state.Length - state.Offset
		reader = io.LimitReader(r.Body, remaining+1)
	}
	n, copyErr := io.Copy(f, reader)
	if remaining >= 0 && n > remaining {
		_ = f.Truncate(state.Offset)
		_ = f.Sync()
		_ = f.Close()
		jsonError(w, http.StatusBadRequest, "upload_too_large",
			"uploaded bytes exceed Upload-Length")
		return
	}
	if copyErr != nil {
		_ = f.Close()
		jsonError(w, http.StatusInternalServerError, "upload_append_failed", copyErr.Error())
		return
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		jsonError(w, http.StatusInternalServerError, "upload_append_failed", err.Error())
		return
	}
	closeErr := f.Close()
	if closeErr != nil {
		jsonError(w, http.StatusInternalServerError, "upload_append_failed", closeErr.Error())
		return
	}
	state.Offset += n
	if err := writeUploadState(state); err != nil {
		jsonError(w, http.StatusInternalServerError, "upload_state_failed", err.Error())
		return
	}
	w.Header().Set("Tus-Resumable", "1.0.0")
	w.Header().Set("Upload-Offset", strconv.FormatInt(state.Offset, 10))
	w.WriteHeader(http.StatusNoContent)
}

type finalizeRequest struct {
	SHA256 string `json:"sha256"`
	LabID  string `json:"lab_id"`
}

func finalizeDatasetUpload(w http.ResponseWriter, r *http.Request, id string) {
	lock := datasetUploadLock(id)
	lock.Lock()
	defer lock.Unlock()

	state, err := readUploadState(id)
	if err != nil {
		jsonError(w, http.StatusNotFound, "upload_not_found", "upload not found")
		return
	}
	var req finalizeRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	versionDir := filepath.Join(datasetRoot(), state.DatasetID, "v1")
	if meta, err := readDatasetMeta(state.DatasetID); err == nil {
		_ = os.Remove(uploadStatePath(id))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(meta)
		return
	}
	if state.Length >= 0 && state.Offset != state.Length {
		jsonError(w, http.StatusConflict, "upload_incomplete", "upload is incomplete")
		return
	}
	expectedHash := strings.TrimSpace(r.Header.Get("X-Content-SHA256"))
	if expectedHash == "" {
		expectedHash = strings.TrimSpace(req.SHA256)
	}
	dataName := datasetDataFileName(state)
	finalDataPath := filepath.Join(versionDir, dataName)
	if _, err := os.Stat(finalDataPath); err == nil {
		finalizePartiallyPublishedDataset(w, id, state, req, dataName, finalDataPath, expectedHash)
		return
	}
	stagingDir := filepath.Join(datasetRoot(), state.DatasetID, ".v1."+id+".staging")
	stagedDataPath := filepath.Join(stagingDir, dataName)
	if _, err := os.Stat(stagedDataPath); err == nil {
		finalizeStagedDataset(w, id, versionDir, stagingDir, stagedDataPath, expectedHash)
		return
	}
	actualHash, err := sha256File(uploadDataPath(id))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "hash_failed", err.Error())
		return
	}
	if expectedHash != "" && !constantTimeStringEq(strings.ToLower(expectedHash), actualHash) {
		jsonError(w, http.StatusConflict, "hash_mismatch", "sha256 mismatch")
		return
	}
	labID := strings.TrimSpace(req.LabID)
	if labID == "" {
		labID = strings.TrimSpace(state.LabID)
	}
	meta := buildDatasetMeta(state, labID, dataName, actualHash, uploadDataPath(id))
	metaBytes, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "metadata_failed", err.Error())
		return
	}
	if err := prepareDatasetStaging(stagingDir, metaBytes); err != nil {
		jsonError(w, http.StatusInternalServerError, "dataset_create_failed", err.Error())
		return
	}
	if err := os.Rename(uploadDataPath(id), stagedDataPath); err != nil {
		jsonError(w, http.StatusInternalServerError, "dataset_create_failed", err.Error())
		return
	}
	if err := syncFile(stagedDataPath); err != nil {
		jsonError(w, http.StatusInternalServerError, "dataset_create_failed", err.Error())
		return
	}
	if err := syncDir(stagingDir); err != nil {
		jsonError(w, http.StatusInternalServerError, "dataset_create_failed", err.Error())
		return
	}
	if err := publishStagedDataset(stagingDir, versionDir); err != nil {
		if meta, readErr := readDatasetMeta(state.DatasetID); readErr == nil {
			_ = os.Remove(uploadStatePath(id))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(meta)
			return
		}
		jsonError(w, http.StatusInternalServerError, "dataset_create_failed", err.Error())
		return
	}
	_ = os.Remove(uploadStatePath(id))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(meta)
}

func finalizePartiallyPublishedDataset(
	w http.ResponseWriter,
	uploadID string,
	state datasetUploadState,
	req finalizeRequest,
	dataName, finalDataPath, expectedHash string,
) {
	actualHash, err := sha256File(finalDataPath)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "hash_failed", err.Error())
		return
	}
	if expectedHash != "" && !constantTimeStringEq(strings.ToLower(expectedHash), actualHash) {
		jsonError(w, http.StatusConflict, "hash_mismatch", "sha256 mismatch")
		return
	}
	labID := strings.TrimSpace(req.LabID)
	if labID == "" {
		labID = strings.TrimSpace(state.LabID)
	}
	meta := buildDatasetMeta(state, labID, dataName, actualHash, finalDataPath)
	metaBytes, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "metadata_failed", err.Error())
		return
	}
	if err := writeFinalMeta(filepath.Dir(finalDataPath), metaBytes); err != nil {
		jsonError(w, http.StatusInternalServerError, "metadata_failed", err.Error())
		return
	}
	_ = os.Remove(uploadStatePath(uploadID))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(meta)
}

func finalizeStagedDataset(
	w http.ResponseWriter,
	uploadID, versionDir, stagingDir, stagedDataPath, expectedHash string,
) {
	actualHash, err := sha256File(stagedDataPath)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "hash_failed", err.Error())
		return
	}
	if expectedHash != "" && !constantTimeStringEq(strings.ToLower(expectedHash), actualHash) {
		jsonError(w, http.StatusConflict, "hash_mismatch", "sha256 mismatch")
		return
	}
	meta, err := readDatasetMetaAt(filepath.Join(stagingDir, "meta.json"))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "metadata_failed", err.Error())
		return
	}
	if err := publishStagedDataset(stagingDir, versionDir); err != nil {
		jsonError(w, http.StatusInternalServerError, "dataset_create_failed", err.Error())
		return
	}
	_ = os.Remove(uploadStatePath(uploadID))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(meta)
}

func datasetDataFileName(state datasetUploadState) string {
	if strings.EqualFold(filepath.Ext(state.Filename), ".parquet") ||
		strings.Contains(strings.ToLower(state.ContentType), "parquet") {
		return "data.parquet"
	}
	return "data.bin"
}

func buildDatasetMeta(state datasetUploadState, labID, dataName, actualHash, dataPath string) map[string]any {
	return map[string]any{
		"dataset_id":   state.DatasetID,
		"version":      "v1",
		"tenant_id":    tenantID(),
		"lab_id":       labID,
		"filename":     state.Filename,
		"content_type": state.ContentType,
		"bytes":        state.Offset,
		"sha256":       actualHash,
		"data_file":    dataName,
		"schema":       inferDatasetSchema(dataPath, state),
		"created_at":   time.Now().UTC().Format(time.RFC3339),
	}
}

func prepareDatasetStaging(stagingDir string, metaBytes []byte) error {
	if err := os.RemoveAll(stagingDir); err != nil {
		return err
	}
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return err
	}
	return writeFinalMeta(stagingDir, metaBytes)
}

func writeFinalMeta(dir string, metaBytes []byte) error {
	tmp := filepath.Join(dir, "meta.json.tmp")
	if err := os.WriteFile(tmp, metaBytes, 0o600); err != nil {
		return err
	}
	if err := syncFile(tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, "meta.json")); err != nil {
		return err
	}
	return syncDir(dir)
}

func publishStagedDataset(stagingDir, versionDir string) error {
	parentDir := filepath.Dir(versionDir)
	if err := os.MkdirAll(parentDir, 0o700); err != nil {
		return err
	}
	if err := os.Rename(stagingDir, versionDir); err != nil {
		return err
	}
	return syncDir(parentDir)
}

func syncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func validDatasetID(id string) bool {
	if !strings.HasPrefix(id, "ds_") || len(id) != 35 {
		return false
	}
	for _, ch := range strings.TrimPrefix(id, "ds_") {
		if !((ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9')) {
			return false
		}
	}
	return true
}

func readDatasetMeta(id string) (map[string]any, error) {
	if !validDatasetID(id) {
		return nil, os.ErrNotExist
	}
	return readDatasetMetaAt(filepath.Join(datasetRoot(), id, "v1", "meta.json"))
}

func readDatasetMetaAt(path string) (map[string]any, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var meta map[string]any
	if err := json.Unmarshal(b, &meta); err != nil {
		return nil, err
	}
	return meta, nil
}

func listFinalizedDatasets(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(datasetRoot())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		jsonError(w, http.StatusInternalServerError, "dataset_list_failed", err.Error())
		return
	}
	filterLabID := strings.TrimSpace(r.URL.Query().Get("lab_id"))
	datasets := []map[string]any{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		meta, err := readDatasetMeta(entry.Name())
		if err != nil {
			continue
		}
		if filterLabID != "" && strings.TrimSpace(fmt.Sprint(meta["lab_id"])) != filterLabID {
			continue
		}
		datasets = append(datasets, meta)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"datasets": datasets})
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func inferDatasetSchema(path string, state datasetUploadState) map[string]any {
	kind := strings.TrimPrefix(strings.ToLower(filepath.Ext(state.Filename)), ".")
	if strings.Contains(strings.ToLower(state.ContentType), "json") {
		kind = "jsonl"
	}
	if strings.Contains(strings.ToLower(state.ContentType), "csv") {
		kind = "csv"
	}
	if strings.Contains(strings.ToLower(state.ContentType), "parquet") || kind == "parquet" {
		return map[string]any{"format": "parquet", "status": "unsupported_without_parquet_dependency"}
	}
	sample, err := readSample(path, datasetSampleLimit)
	if err != nil {
		return map[string]any{"format": kind, "status": "sample_unavailable"}
	}
	switch kind {
	case "csv":
		return inferCSVSchema(sample)
	case "jsonl", "json":
		return inferJSONLSchema(sample)
	default:
		return map[string]any{"format": "binary", "status": "unsupported"}
	}
}

func readSample(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit))
}

func inferCSVSchema(sample []byte) map[string]any {
	r := csv.NewReader(strings.NewReader(string(sample)))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil || len(rows) == 0 {
		return map[string]any{"format": "csv", "status": "parse_failed"}
	}
	cols := make([]map[string]string, 0, len(rows[0]))
	for i, name := range rows[0] {
		if strings.TrimSpace(name) == "" {
			name = fmt.Sprintf("column_%d", i+1)
		}
		cols = append(cols, map[string]string{"name": name, "type": "string"})
	}
	return map[string]any{"format": "csv", "columns": cols, "sample_rows": len(rows) - 1}
}

func inferJSONLSchema(sample []byte) map[string]any {
	fields := map[string]string{}
	rows := 0
	for _, line := range strings.Split(string(sample), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			continue
		}
		rows++
		for k, v := range obj {
			fields[k] = jsonType(v)
		}
	}
	cols := make([]map[string]string, 0, len(fields))
	for k, typ := range fields {
		cols = append(cols, map[string]string{"name": k, "type": typ})
	}
	return map[string]any{"format": "jsonl", "columns": cols, "sample_rows": rows}
}

func jsonType(v any) string {
	switch v.(type) {
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case nil:
		return "null"
	default:
		return "object"
	}
}
