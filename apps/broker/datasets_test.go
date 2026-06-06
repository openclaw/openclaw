package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func setDatasetTestEnv(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("BROKER_TENANT_TOKEN", "test-token")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-datasets")
	return home
}

func datasetMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/datasets", finalizedDatasets)
	mux.HandleFunc("/datasets/uploads", newDatasetUpload)
	mux.HandleFunc("/datasets/uploads/", datasetUploadByID)
	mux.HandleFunc("/datasets/", finalizedDatasetByID)
	return mux
}

func createUpload(t *testing.T, mux http.Handler, filename string, length int, metadata ...string) (string, string) {
	t.Helper()
	meta := "filename " + base64.StdEncoding.EncodeToString([]byte(filename))
	for _, item := range metadata {
		meta += "," + item
	}
	req := httptest.NewRequest(http.MethodPost, "/datasets/uploads", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Length", strconv.Itoa(length))
	req.Header.Set("Upload-Metadata", meta)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create upload status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("create upload body json: %v", err)
	}
	return body["upload_id"], body["dataset_id"]
}

func uploadAndFinalizeDataset(t *testing.T, mux http.Handler, filename, data string, metadata ...string) (string, map[string]any) {
	t.Helper()
	uploadID, datasetID := createUpload(t, mux, filename, len(data), metadata...)
	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader(data))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest(http.MethodPost, "/datasets/uploads/"+uploadID+"/finalize", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("finalize status=%d body=%s", rec.Code, rec.Body.String())
	}
	var meta map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &meta); err != nil {
		t.Fatalf("finalize body json: %v", err)
	}
	if got := fmt.Sprint(meta["dataset_id"]); got != datasetID {
		t.Fatalf("finalize dataset_id=%q want %q", got, datasetID)
	}
	return datasetID, meta
}

func TestDatasetUploadRequiresBrokerAuthAndTenantID(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("BROKER_TENANT_TOKEN", "test-token")
	mux := datasetMux()

	req := httptest.NewRequest(http.MethodPost, "/datasets/uploads", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/datasets/uploads", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 without tenant id, got %d", rec.Code)
	}
}

func TestDatasetUploadOffsetAndHead(t *testing.T) {
	setDatasetTestEnv(t)
	mux := datasetMux()
	uploadID, _ := createUpload(t, mux, "data.csv", 6)

	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader("abc"))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "1")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected offset conflict, got %d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader("abc"))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Upload-Offset") != "3" {
		t.Fatalf("patch got status=%d offset=%q", rec.Code, rec.Header().Get("Upload-Offset"))
	}

	req = httptest.NewRequest(http.MethodHead, "/datasets/uploads/"+uploadID, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Upload-Offset") != "3" {
		t.Fatalf("head got status=%d offset=%q", rec.Code, rec.Header().Get("Upload-Offset"))
	}
}

func TestDatasetConcurrentPatchesSerializeOffsetMutation(t *testing.T) {
	setDatasetTestEnv(t)
	mux := datasetMux()
	uploadID, _ := createUpload(t, mux, "data.csv", 3)

	var wg sync.WaitGroup
	statuses := make(chan int, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader("abc"))
			req.Header.Set("Authorization", "Bearer test-token")
			req.Header.Set("Upload-Offset", "0")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			statuses <- rec.Code
		}()
	}
	wg.Wait()
	close(statuses)

	successes := 0
	conflicts := 0
	for status := range statuses {
		switch status {
		case http.StatusNoContent:
			successes++
		case http.StatusConflict:
			conflicts++
		default:
			t.Fatalf("unexpected concurrent patch status %d", status)
		}
	}
	if successes != 1 || conflicts != 7 {
		t.Fatalf("expected one success and seven conflicts, got successes=%d conflicts=%d", successes, conflicts)
	}
	if got, err := os.ReadFile(uploadDataPath(uploadID)); err != nil || string(got) != "abc" {
		t.Fatalf("upload data mismatch err=%v got=%q", err, got)
	}
	state, err := readUploadState(uploadID)
	if err != nil {
		t.Fatalf("read upload state: %v", err)
	}
	if state.Offset != 3 {
		t.Fatalf("offset=%d want 3", state.Offset)
	}
}

func TestDatasetFinalizeWritesUnderHomeWithHashAndCSVSchema(t *testing.T) {
	home := setDatasetTestEnv(t)
	mux := datasetMux()
	data := "name,score\nsam,10\n"
	uploadID, datasetID := createUpload(t, mux, "scores.csv", len(data))

	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader(data))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}

	sum := sha256.Sum256([]byte(data))
	req = httptest.NewRequest(http.MethodPost, "/datasets/uploads/"+uploadID+"/finalize", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("X-Content-SHA256", hex.EncodeToString(sum[:]))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("finalize status=%d body=%s", rec.Code, rec.Body.String())
	}
	dataPath := filepath.Join(home, "datasets", datasetID, "v1", "data.bin")
	if got, err := os.ReadFile(dataPath); err != nil || string(got) != data {
		t.Fatalf("final data mismatch err=%v got=%q", err, got)
	}
	metaBytes, err := os.ReadFile(filepath.Join(home, "datasets", datasetID, "v1", "meta.json"))
	if err != nil {
		t.Fatalf("missing meta.json: %v", err)
	}
	if !strings.Contains(string(metaBytes), `"tenant_id": "tenant-datasets"`) ||
		!strings.Contains(string(metaBytes), `"format": "csv"`) ||
		!strings.Contains(string(metaBytes), `"name": "score"`) {
		t.Fatalf("metadata missing tenant/schema fields: %s", string(metaBytes))
	}
}

func TestDatasetFinalizeRecoversDataMovedBeforeMetadata(t *testing.T) {
	home := setDatasetTestEnv(t)
	mux := datasetMux()
	data := "name,score\nsam,10\n"
	uploadID, datasetID := createUpload(t, mux, "scores.csv", len(data))

	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader(data))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}

	versionDir := filepath.Join(home, "datasets", datasetID, "v1")
	if err := os.MkdirAll(versionDir, 0o700); err != nil {
		t.Fatalf("mkdir version dir: %v", err)
	}
	if err := os.Rename(uploadDataPath(uploadID), filepath.Join(versionDir, "data.bin")); err != nil {
		t.Fatalf("simulate partial finalize: %v", err)
	}

	req = httptest.NewRequest(http.MethodPost, "/datasets/uploads/"+uploadID+"/finalize", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("finalize status=%d body=%s", rec.Code, rec.Body.String())
	}
	metaBytes, err := os.ReadFile(filepath.Join(versionDir, "meta.json"))
	if err != nil {
		t.Fatalf("missing recovered meta.json: %v", err)
	}
	if !strings.Contains(string(metaBytes), `"dataset_id": "`+datasetID+`"`) ||
		!strings.Contains(string(metaBytes), `"format": "csv"`) {
		t.Fatalf("recovered metadata missing fields: %s", string(metaBytes))
	}
	if _, err := os.Stat(uploadStatePath(uploadID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("upload state should be removed after recovery, err=%v", err)
	}
}

func TestDatasetFinalizePreservesLabIDFromUploadMetadataAndBody(t *testing.T) {
	setDatasetTestEnv(t)
	mux := datasetMux()
	labMeta := "lab_id " + base64.StdEncoding.EncodeToString([]byte("notebook:lab-a"))
	uploadID, datasetID := createUpload(t, mux, "scores.csv", 4, labMeta)

	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader("a,b\n"))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(
		http.MethodPost,
		"/datasets/uploads/"+uploadID+"/finalize",
		strings.NewReader(`{"lab_id":"notebook:lab-b"}`),
	)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("finalize status=%d body=%s", rec.Code, rec.Body.String())
	}
	metaBytes, err := os.ReadFile(filepath.Join(datasetRoot(), datasetID, "v1", "meta.json"))
	if err != nil {
		t.Fatalf("missing meta.json: %v", err)
	}
	if !strings.Contains(string(metaBytes), `"lab_id": "notebook:lab-b"`) {
		t.Fatalf("expected finalize lab_id override in metadata: %s", string(metaBytes))
	}
}

func TestDatasetListDetailAndLabIDFilter(t *testing.T) {
	setDatasetTestEnv(t)
	mux := datasetMux()
	labA := "lab_id " + base64.StdEncoding.EncodeToString([]byte("notebook:lab-a"))
	labB := "lab_id " + base64.StdEncoding.EncodeToString([]byte("notebook:lab-b"))
	datasetA, _ := uploadAndFinalizeDataset(t, mux, "a.csv", "name\nsam\n", labA)
	datasetB, _ := uploadAndFinalizeDataset(t, mux, "b.csv", "name\nlee\n", labB)

	req := httptest.NewRequest(http.MethodGet, "/datasets?lab_id=notebook:lab-a", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listBody struct {
		Datasets []map[string]any `json:"datasets"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("list json: %v", err)
	}
	if len(listBody.Datasets) != 1 || fmt.Sprint(listBody.Datasets[0]["dataset_id"]) != datasetA {
		t.Fatalf("unexpected filtered datasets: %#v", listBody.Datasets)
	}

	req = httptest.NewRequest(http.MethodGet, "/datasets/"+datasetB, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("detail status=%d body=%s", rec.Code, rec.Body.String())
	}
	var detail map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("detail json: %v", err)
	}
	if fmt.Sprint(detail["dataset_id"]) != datasetB || fmt.Sprint(detail["lab_id"]) != "notebook:lab-b" {
		t.Fatalf("unexpected detail: %#v", detail)
	}

	req = httptest.NewRequest(http.MethodGet, "/datasets/ds_00000000000000000000000000000000", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing detail status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDatasetFinalizeRejectsHashMismatch(t *testing.T) {
	setDatasetTestEnv(t)
	mux := datasetMux()
	uploadID, _ := createUpload(t, mux, "data.jsonl", 8)
	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader(`{"a":1}`+"\n"))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("patch status=%d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/datasets/uploads/"+uploadID+"/finalize", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("X-Content-SHA256", strings.Repeat("0", 64))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected hash conflict, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDatasetUploadRejectsPathFilenames(t *testing.T) {
	setDatasetTestEnv(t)
	mux := datasetMux()
	meta := "filename " + base64.StdEncoding.EncodeToString([]byte("../escape.csv"))
	req := httptest.NewRequest(http.MethodPost, "/datasets/uploads", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Metadata", meta)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid filename, got %d", rec.Code)
	}
}

func TestDatasetFinalizeParquetMetadataIsUnsupportedBestEffort(t *testing.T) {
	home := setDatasetTestEnv(t)
	mux := datasetMux()
	data := "PAR1not-really-parquet"
	uploadID, datasetID := createUpload(t, mux, "data.parquet", len(data))
	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader(data))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("patch status=%d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodPost, "/datasets/uploads/"+uploadID+"/finalize", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("finalize status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(home, "datasets", datasetID, "v1", "data.parquet")); err != nil {
		t.Fatalf("expected parquet data path: %v", err)
	}
	meta, _ := os.ReadFile(filepath.Join(home, "datasets", datasetID, "v1", "meta.json"))
	if !strings.Contains(string(meta), "unsupported_without_parquet_dependency") {
		t.Fatalf("expected best-effort parquet metadata, got %s", string(meta))
	}
}
