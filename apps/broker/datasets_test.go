package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	if length >= 0 {
		req.Header.Set("Upload-Length", strconv.Itoa(length))
	}
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

func TestDatasetUploadFreeSpaceFloorAllowsWhenTrivialFloor(t *testing.T) {
	setDatasetTestEnv(t)
	t.Setenv("DATASET_FREE_SPACE_FLOOR_BYTES", "1")
	mux := datasetMux()

	uploadID, _ := createUpload(t, mux, "data.csv", 3)
	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader("abc"))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("patch under trivial floor status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDatasetUploadFreeSpaceFloorRejectsCreateAndPatch(t *testing.T) {
	setDatasetTestEnv(t)
	mux := datasetMux()
	uploadID, _ := createUpload(t, mux, "data.csv", 3)

	t.Setenv("DATASET_FREE_SPACE_FLOOR_BYTES", strconv.FormatInt(1<<60, 10))

	req := httptest.NewRequest(http.MethodPost, "/datasets/uploads", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Length", "3")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("create above floor status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertVolumeFloorError(t, rec.Body.Bytes())

	req = httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, strings.NewReader("abc"))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("patch above floor status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertVolumeFloorError(t, rec.Body.Bytes())
	if got, err := os.ReadFile(uploadDataPath(uploadID)); err == nil {
		t.Fatalf("patch above floor must not write chunk bytes, found %q", got)
	}
}

// floorWithBudget reads the volume's real free space and pins the floor so
// only `budget` bytes may be written before crossing the reserve.
func floorWithBudget(t *testing.T, budget int64) {
	t.Helper()
	free, err := datasetVolumeFreeBytes()
	if err != nil {
		t.Fatalf("statfs dataset volume: %v", err)
	}
	if free <= budget {
		t.Skipf("volume too full for budget test: free=%d budget=%d", free, budget)
	}
	t.Setenv("DATASET_FREE_SPACE_FLOOR_BYTES", strconv.FormatInt(free-budget, 10))
}

func TestDatasetCreateRejectsUploadLengthOverFloorBudget(t *testing.T) {
	setDatasetTestEnv(t)
	mux := datasetMux()
	budget := int64(64 << 20)
	floorWithBudget(t, budget)

	req := httptest.NewRequest(http.MethodPost, "/datasets/uploads", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Length", strconv.FormatInt(budget+(1<<20), 10))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("create over budget status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertVolumeFloorError(t, rec.Body.Bytes())

	// A declared length that fits above the floor is still admitted.
	createUpload(t, mux, "fits.bin", 1024)
}

func TestDatasetPatchRejectsDeclaredBodyOverFloorBudget(t *testing.T) {
	setDatasetTestEnv(t)
	t.Setenv("DATASET_FREE_SPACE_FLOOR_BYTES", "1")
	mux := datasetMux()
	uploadID, _ := createUpload(t, mux, "data.bin", 32<<20)

	// Free space starts just above the floor: only ~1 MiB budget remains.
	floorWithBudget(t, 1<<20)

	body := bytes.NewReader(make([]byte, 8<<20)) // declared Content-Length 8 MiB
	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, body)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("declared over-budget patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertVolumeFloorError(t, rec.Body.Bytes())
	if _, err := os.Stat(uploadDataPath(uploadID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("declared over-budget patch must not write chunk bytes, err=%v", err)
	}
}

func TestDatasetPatchDeferredLengthStopsBeforeCrossingFloor(t *testing.T) {
	setDatasetTestEnv(t)
	t.Setenv("DATASET_FREE_SPACE_FLOOR_BYTES", "1")
	mux := datasetMux()
	uploadID, _ := createUpload(t, mux, "data.bin", -1) // deferred Upload-Length

	budget := int64(1 << 20)
	floorWithBudget(t, budget)

	// io.MultiReader hides the concrete type, so httptest leaves
	// ContentLength at -1 (chunked/unknown-length body).
	body := io.MultiReader(bytes.NewReader(make([]byte, 8<<20)))
	req := httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID, body)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	if req.ContentLength != -1 {
		t.Fatalf("test setup: ContentLength=%d, want -1 (unknown)", req.ContentLength)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("deferred-length over-budget patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertVolumeFloorError(t, rec.Body.Bytes())
	if fi, err := os.Stat(uploadDataPath(uploadID)); err == nil && fi.Size() != 0 {
		t.Fatalf("partial chunk must be discarded, size=%d", fi.Size())
	}
	state, err := readUploadState(uploadID)
	if err != nil || state.Offset != 0 {
		t.Fatalf("offset must stay durable at 0 for retry, err=%v offset=%d", err, state.Offset)
	}
	if free, err := datasetVolumeFreeBytes(); err == nil {
		floor, _ := strconv.ParseInt(os.Getenv("DATASET_FREE_SPACE_FLOOR_BYTES"), 10, 64)
		if free < floor {
			t.Fatalf("volume crossed the reserve: free=%d floor=%d", free, floor)
		}
	}

	// An unknown-length body that fits inside the budget still streams through.
	req = httptest.NewRequest(http.MethodPatch, "/datasets/uploads/"+uploadID,
		io.MultiReader(strings.NewReader("abc")))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Upload-Offset", "0")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Upload-Offset") != "3" {
		t.Fatalf("under-budget deferred patch status=%d offset=%q body=%s",
			rec.Code, rec.Header().Get("Upload-Offset"), rec.Body.String())
	}
	if got, err := os.ReadFile(uploadDataPath(uploadID)); err != nil || string(got) != "abc" {
		t.Fatalf("budget reader corrupted data err=%v got=%q", err, got)
	}
}

func assertVolumeFloorError(t *testing.T, body []byte) {
	t.Helper()
	var payload map[string]map[string]string
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("floor error body json: %v body=%s", err, body)
	}
	if payload["error"]["code"] != "volume_free_space_floor" {
		t.Fatalf("floor error code=%q body=%s", payload["error"]["code"], body)
	}
	if !strings.Contains(payload["error"]["message"], "nearly full") {
		t.Fatalf("floor error message=%q", payload["error"]["message"])
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

func TestDatasetDeleteRemovesFinalizedDatasetAndIsIdempotent(t *testing.T) {
	home := setDatasetTestEnv(t)
	mux := datasetMux()
	datasetID, _ := uploadAndFinalizeDataset(t, mux, "delete.csv", "name\nsam\n")
	orphanStagingDir := filepath.Join(home, "datasets", datasetID, ".v1.upl_11111111111111111111111111111111.staging")
	if err := os.MkdirAll(orphanStagingDir, 0o700); err != nil {
		t.Fatalf("create orphan staging dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(orphanStagingDir, "data.bin"), []byte("orphan staging bytes"), 0o600); err != nil {
		t.Fatalf("write orphan staging data: %v", err)
	}
	liveUploadID := "upl_22222222222222222222222222222222"
	liveStagingDir := filepath.Join(home, "datasets", datasetID, ".v1."+liveUploadID+".staging")
	if err := os.MkdirAll(liveStagingDir, 0o700); err != nil {
		t.Fatalf("create live staging dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(liveStagingDir, "data.bin"), []byte("pending upload bytes"), 0o600); err != nil {
		t.Fatalf("write live staging data: %v", err)
	}
	if err := os.WriteFile(uploadStatePath(liveUploadID), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write live upload state: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/datasets/"+datasetID, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("delete body json: %v", err)
	}
	if body["dataset_id"] != datasetID || body["version"] != "v1" || body["deleted"] != true || body["status"] != "deleted" {
		t.Fatalf("unexpected delete body: %#v", body)
	}

	req = httptest.NewRequest(http.MethodGet, "/datasets/"+datasetID, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected deleted detail 404, got %d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/datasets", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listBody struct {
		Datasets []map[string]any `json:"datasets"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("list body json: %v", err)
	}
	for _, item := range listBody.Datasets {
		if item["dataset_id"] == datasetID {
			t.Fatalf("deleted dataset still listed: %#v", listBody.Datasets)
		}
	}

	versionDir := filepath.Join(home, "datasets", datasetID, "v1")
	for _, name := range []string{"data.bin", "meta.json"} {
		if _, err := os.Stat(filepath.Join(versionDir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s should be removed, err=%v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(orphanStagingDir, "data.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan staging data should be removed, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(liveStagingDir, "data.bin")); err != nil {
		t.Fatalf("live staging data should remain after delete: %v", err)
	}

	req = httptest.NewRequest(http.MethodDelete, "/datasets/"+datasetID, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("second delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	body = map[string]any{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("second delete body json: %v", err)
	}
	if body["deleted"] != false || body["status"] != "not_found" {
		t.Fatalf("unexpected idempotent delete body: %#v", body)
	}
}

func TestDatasetDeleteRequiresAuthBeforeRemovingFiles(t *testing.T) {
	home := setDatasetTestEnv(t)
	mux := datasetMux()
	datasetID, _ := uploadAndFinalizeDataset(t, mux, "keep.csv", "name\nsam\n")

	req := httptest.NewRequest(http.MethodDelete, "/datasets/"+datasetID, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthenticated delete 401, got %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(home, "datasets", datasetID, "v1", "data.bin")); err != nil {
		t.Fatalf("unauthenticated delete removed data: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "datasets", datasetID, "v1", "meta.json")); err != nil {
		t.Fatalf("unauthenticated delete removed metadata: %v", err)
	}
}

func TestDatasetDeleteInvalidIDReturnsNotFoundSuccess(t *testing.T) {
	home := setDatasetTestEnv(t)
	mux := datasetMux()
	datasetID, _ := uploadAndFinalizeDataset(t, mux, "safe.csv", "name\nsam\n")

	req := httptest.NewRequest(http.MethodDelete, "/datasets/not-a-dataset", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("invalid id delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid id delete body json: %v", err)
	}
	if body["dataset_id"] != "not-a-dataset" || body["deleted"] != false || body["status"] != "not_found" {
		t.Fatalf("unexpected invalid id delete body: %#v", body)
	}
	if _, err := os.Stat(filepath.Join(home, "datasets", datasetID, "v1", "data.bin")); err != nil {
		t.Fatalf("invalid id delete touched existing dataset: %v", err)
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
