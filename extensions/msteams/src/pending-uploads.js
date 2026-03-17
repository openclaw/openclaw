import crypto from "node:crypto";
const pendingUploads = /* @__PURE__ */ new Map();
const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1e3;
function storePendingUpload(upload) {
  const id = crypto.randomUUID();
  const entry = {
    ...upload,
    id,
    createdAt: Date.now()
  };
  pendingUploads.set(id, entry);
  setTimeout(() => {
    pendingUploads.delete(id);
  }, PENDING_UPLOAD_TTL_MS);
  return id;
}
function getPendingUpload(id) {
  if (!id) {
    return void 0;
  }
  const entry = pendingUploads.get(id);
  if (!entry) {
    return void 0;
  }
  if (Date.now() - entry.createdAt > PENDING_UPLOAD_TTL_MS) {
    pendingUploads.delete(id);
    return void 0;
  }
  return entry;
}
function removePendingUpload(id) {
  if (id) {
    pendingUploads.delete(id);
  }
}
function getPendingUploadCount() {
  return pendingUploads.size;
}
function clearPendingUploads() {
  pendingUploads.clear();
}
export {
  clearPendingUploads,
  getPendingUpload,
  getPendingUploadCount,
  removePendingUpload,
  storePendingUpload
};
