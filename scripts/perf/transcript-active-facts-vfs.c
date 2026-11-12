/* SQLite VFS counters for the synthetic transcript-active-facts workload.
 * Build on macOS (no link to a second SQLite library):
 *   clang -O2 -Wall -Wextra -dynamiclib -I/opt/homebrew/opt/sqlite/include \
 *     scripts/perf/transcript-active-facts-vfs.c -o .local/active-facts/bufprobe.dylib
 * Linux: replace -dynamiclib with -shared -fPIC and use the SQLite header path.
 * Load with entrypoint sqlite3_bufprobe_init, or name the library bufprobe.
 *
 * Install only after maintenance lease/worker initialization. Run one serial
 * measurement at a time, and call buf696_restore() before owner cleanup. Loading
 * changes the process default VFS for subsequent connections; it does not wrap
 * connections already open. Keep the extension's control connection open while
 * measuring. The extension is process-lived so delayed native closes cannot call
 * unloaded VFS methods. Never load this tool in a serving Gateway.
 *
 * buf696_reset() resets process-wide I/O and this connection's pager counters.
 * buf696_io() returns both as JSON; page_reads counts intersected 4 KiB page spans,
 * including repeated and short overflow-pointer reads. These are logical VFS
 * operations, not physical disk reads. Disable mmap and release SQLite's cache
 * in the caller; neither this probe nor the fixture generator evicts OS cache.
 */
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
#include <stdint.h>
#include <string.h>

typedef struct {
  uint64_t reads, read_bytes, writes, write_bytes, page_reads, small_reads;
} Io;

typedef struct {
  sqlite3_file base;
  sqlite3_file *real;
  int kind;
} File;

static sqlite3_vfs *under;
static Io counters[4]; /* main, WAL, journal, other */
static int counting;
static const int page_size = 4096;

static int close_file(sqlite3_file *file) {
  File *f = (File *)file;
  return f->real->pMethods->xClose(f->real);
}

static int read_file(sqlite3_file *file, void *buffer, int bytes, sqlite3_int64 offset) {
  File *f = (File *)file;
  if (counting) {
    Io *counter = &counters[f->kind];
    counter->reads++;
    counter->read_bytes += bytes;
    counter->small_reads += bytes < page_size;
    counter->page_reads += (offset + bytes - 1) / page_size - offset / page_size + 1;
  }
  return f->real->pMethods->xRead(f->real, buffer, bytes, offset);
}

static int write_file(sqlite3_file *file, const void *buffer, int bytes, sqlite3_int64 offset) {
  File *f = (File *)file;
  if (counting) {
    counters[f->kind].writes++;
    counters[f->kind].write_bytes += bytes;
  }
  return f->real->pMethods->xWrite(f->real, buffer, bytes, offset);
}

static int truncate_file(sqlite3_file *file, sqlite3_int64 size) {
  File *f = (File *)file;
  return f->real->pMethods->xTruncate(f->real, size);
}

static int sync_file(sqlite3_file *file, int flags) {
  File *f = (File *)file;
  return f->real->pMethods->xSync(f->real, flags);
}

static int size_file(sqlite3_file *file, sqlite3_int64 *size) {
  File *f = (File *)file;
  return f->real->pMethods->xFileSize(f->real, size);
}

static int lock_file(sqlite3_file *file, int level) {
  File *f = (File *)file;
  return f->real->pMethods->xLock(f->real, level);
}

static int unlock_file(sqlite3_file *file, int level) {
  File *f = (File *)file;
  return f->real->pMethods->xUnlock(f->real, level);
}

static int check_file(sqlite3_file *file, int *result) {
  File *f = (File *)file;
  return f->real->pMethods->xCheckReservedLock(f->real, result);
}

static int control_file(sqlite3_file *file, int operation, void *argument) {
  File *f = (File *)file;
  return f->real->pMethods->xFileControl(f->real, operation, argument);
}

static int sector_file(sqlite3_file *file) {
  File *f = (File *)file;
  return f->real->pMethods->xSectorSize(f->real);
}

static int device_file(sqlite3_file *file) {
  File *f = (File *)file;
  return f->real->pMethods->xDeviceCharacteristics(f->real);
}

static int shm_map(sqlite3_file *file, int page, int bytes, int extend, void volatile **result) {
  File *f = (File *)file;
  return f->real->pMethods->xShmMap(f->real, page, bytes, extend, result);
}

static int shm_lock(sqlite3_file *file, int offset, int count, int flags) {
  File *f = (File *)file;
  return f->real->pMethods->xShmLock(f->real, offset, count, flags);
}

static void shm_barrier(sqlite3_file *file) {
  File *f = (File *)file;
  f->real->pMethods->xShmBarrier(f->real);
}

static int shm_unmap(sqlite3_file *file, int remove) {
  File *f = (File *)file;
  return f->real->pMethods->xShmUnmap(f->real, remove);
}

static int fetch_file(sqlite3_file *file, sqlite3_int64 offset, int bytes, void **result) {
  File *f = (File *)file;
  if (f->real->pMethods->iVersion < 3 || !f->real->pMethods->xFetch) {
    *result = NULL;
    return SQLITE_OK;
  }
  return f->real->pMethods->xFetch(f->real, offset, bytes, result);
}

static int unfetch_file(sqlite3_file *file, sqlite3_int64 offset, void *result) {
  File *f = (File *)file;
  if (f->real->pMethods->iVersion < 3 || !f->real->pMethods->xUnfetch) {
    return SQLITE_OK;
  }
  return f->real->pMethods->xUnfetch(f->real, offset, result);
}

static const sqlite3_io_methods io = {
  3, close_file, read_file, write_file, truncate_file, sync_file, size_file,
  lock_file, unlock_file, check_file, control_file, sector_file, device_file,
  shm_map, shm_lock, shm_barrier, shm_unmap, fetch_file, unfetch_file
};

static int open_file(sqlite3_vfs *vfs, const char *name, sqlite3_file *file,
                     int flags, int *out_flags) {
  (void)vfs;
  File *f = (File *)file;
  memset(f, 0, sizeof(*f));
  f->real = (sqlite3_file *)((char *)file + sizeof(File));
  f->kind = flags & SQLITE_OPEN_MAIN_DB ? 0 : flags & SQLITE_OPEN_WAL ? 1 :
    flags & (SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_TEMP_JOURNAL |
             SQLITE_OPEN_SUBJOURNAL | SQLITE_OPEN_SUPER_JOURNAL) ? 2 : 3;
  int result = under->xOpen(under, name, f->real, flags, out_flags);
  if (result == SQLITE_OK) f->base.pMethods = &io;
  return result;
}

static int delete_vfs(sqlite3_vfs *vfs, const char *name, int sync_dir) {
  (void)vfs;
  return under->xDelete(under, name, sync_dir);
}

static int access_vfs(sqlite3_vfs *vfs, const char *name, int flags, int *result) {
  (void)vfs;
  return under->xAccess(under, name, flags, result);
}

static int full_vfs(sqlite3_vfs *vfs, const char *name, int bytes, char *result) {
  (void)vfs;
  return under->xFullPathname(under, name, bytes, result);
}

static void *dlopen_vfs(sqlite3_vfs *vfs, const char *name) {
  (void)vfs;
  return under->xDlOpen(under, name);
}

static void dlerror_vfs(sqlite3_vfs *vfs, int bytes, char *result) {
  (void)vfs;
  under->xDlError(under, bytes, result);
}

static void (*dlsym_vfs(sqlite3_vfs *vfs, void *handle, const char *name))(void) {
  (void)vfs;
  return under->xDlSym(under, handle, name);
}

static void dlclose_vfs(sqlite3_vfs *vfs, void *handle) {
  (void)vfs;
  under->xDlClose(under, handle);
}

static int random_vfs(sqlite3_vfs *vfs, int bytes, char *result) {
  (void)vfs;
  return under->xRandomness(under, bytes, result);
}

static int sleep_vfs(sqlite3_vfs *vfs, int microseconds) {
  (void)vfs;
  return under->xSleep(under, microseconds);
}

static int time_vfs(sqlite3_vfs *vfs, double *result) {
  (void)vfs;
  return under->xCurrentTime(under, result);
}

static int error_vfs(sqlite3_vfs *vfs, int bytes, char *result) {
  (void)vfs;
  return under->xGetLastError ? under->xGetLastError(under, bytes, result) : 0;
}

static int time64_vfs(sqlite3_vfs *vfs, sqlite3_int64 *result) {
  (void)vfs;
  return under->xCurrentTimeInt64(under, result);
}

static int setsys_vfs(sqlite3_vfs *vfs, const char *name, sqlite3_syscall_ptr callback) {
  (void)vfs;
  return under->xSetSystemCall ? under->xSetSystemCall(under, name, callback) : SQLITE_NOTFOUND;
}

static sqlite3_syscall_ptr getsys_vfs(sqlite3_vfs *vfs, const char *name) {
  (void)vfs;
  return under->xGetSystemCall ? under->xGetSystemCall(under, name) : NULL;
}

static const char *nextsys_vfs(sqlite3_vfs *vfs, const char *name) {
  (void)vfs;
  return under->xNextSystemCall ? under->xNextSystemCall(under, name) : NULL;
}

static void restore_vfs(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3_vfs_register(under, 1);
  counting = 0;
  sqlite3_result_int(context, 1);
}

static void reset_counters(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  memset(counters, 0, sizeof(counters));
  counting = 1;
  int current, highwater;
  sqlite3 *db = sqlite3_context_db_handle(context);
  sqlite3_db_status(db, SQLITE_DBSTATUS_CACHE_HIT, &current, &highwater, 1);
  sqlite3_db_status(db, SQLITE_DBSTATUS_CACHE_MISS, &current, &highwater, 1);
  sqlite3_result_int(context, 1);
}

static void read_counters(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3 *db = sqlite3_context_db_handle(context);
  sqlite3_str *out = sqlite3_str_new(db);
  int hits, misses, highwater;
  sqlite3_db_status(db, SQLITE_DBSTATUS_CACHE_HIT, &hits, &highwater, 0);
  sqlite3_db_status(db, SQLITE_DBSTATUS_CACHE_MISS, &misses, &highwater, 0);
  sqlite3_str_appendf(out, "{\"cache_hits\":%d,\"cache_misses\":%d,", hits, misses);
  const char *names[] = {"main", "wal", "journal", "other"};
  for (int index = 0; index < 4; index++) {
    Io value = counters[index];
    sqlite3_str_appendf(out,
      "%s\"%s\":{\"reads\":%llu,\"read_bytes\":%llu,\"page_reads\":%llu,"
      "\"small_reads\":%llu,\"writes\":%llu,\"write_bytes\":%llu}",
      index ? "," : "", names[index],
      (unsigned long long)value.reads, (unsigned long long)value.read_bytes,
      (unsigned long long)value.page_reads, (unsigned long long)value.small_reads,
      (unsigned long long)value.writes, (unsigned long long)value.write_bytes);
  }
  sqlite3_str_appendall(out, "}");
  sqlite3_result_text(context, sqlite3_str_finish(out), -1, sqlite3_free);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_bufprobe_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  if (!under) {
    under = sqlite3_vfs_find(NULL);
    static sqlite3_vfs vfs;
    vfs = *under;
    vfs.zName = "buf696-probe";
    vfs.szOsFile = sizeof(File) + under->szOsFile;
    vfs.pNext = NULL;
    vfs.xOpen = open_file;
    vfs.xDelete = delete_vfs;
    vfs.xAccess = access_vfs;
    vfs.xFullPathname = full_vfs;
    vfs.xDlOpen = dlopen_vfs;
    vfs.xDlError = dlerror_vfs;
    vfs.xDlSym = dlsym_vfs;
    vfs.xDlClose = dlclose_vfs;
    vfs.xRandomness = random_vfs;
    vfs.xSleep = sleep_vfs;
    vfs.xCurrentTime = time_vfs;
    vfs.xGetLastError = error_vfs;
    vfs.xCurrentTimeInt64 = time64_vfs;
    vfs.xSetSystemCall = setsys_vfs;
    vfs.xGetSystemCall = getsys_vfs;
    vfs.xNextSystemCall = nextsys_vfs;
    sqlite3_vfs_register(&vfs, 1);
  }
  int result = sqlite3_create_function(db, "buf696_restore", 0, SQLITE_UTF8, NULL,
                                      restore_vfs, NULL, NULL);
  if (result == SQLITE_OK) result = sqlite3_create_function(
    db, "buf696_reset", 0, SQLITE_UTF8, NULL, reset_counters, NULL, NULL);
  if (result == SQLITE_OK) result = sqlite3_create_function(
    db, "buf696_io", 0, SQLITE_UTF8, NULL, read_counters, NULL, NULL);
  return result == SQLITE_OK ? SQLITE_OK_LOAD_PERMANENTLY : result;
}
