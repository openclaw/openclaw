#ifndef __UVWASI_H__
#define __UVWASI_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "uv.h"
#include "wasi_serdes.h"
#include "wasi_types.h"

#define UVWASI_VERSION_MAJOR 0
#define UVWASI_VERSION_MINOR 0
#define UVWASI_VERSION_PATCH 23
#define UVWASI_VERSION_HEX ((UVWASI_VERSION_MAJOR << 16) | \
                            (UVWASI_VERSION_MINOR <<  8) | \
                            (UVWASI_VERSION_PATCH))
#define UVWASI_STRINGIFY(v) UVWASI_STRINGIFY_HELPER(v)
#define UVWASI_STRINGIFY_HELPER(v) #v
#define UVWASI_VERSION_STRING UVWASI_STRINGIFY(UVWASI_VERSION_MAJOR) "." \
                              UVWASI_STRINGIFY(UVWASI_VERSION_MINOR) "." \
                              UVWASI_STRINGIFY(UVWASI_VERSION_PATCH)
#define UVWASI_VERSION_WASI "snapshot_1"

typedef void* (*uvwasi_malloc)(size_t size, void* mem_user_data);
typedef void (*uvwasi_free)(void* ptr, void* mem_user_data);
typedef void* (*uvwasi_calloc)(size_t nmemb, size_t size, void* mem_user_data);
typedef void* (*uvwasi_realloc)(void* ptr, size_t size, void* mem_user_data);

typedef struct uvwasi_mem_s {
  void* mem_user_data;
  uvwasi_malloc malloc;
  uvwasi_free free;
  uvwasi_calloc calloc;
  uvwasi_realloc realloc;
} uvwasi_mem_t;

struct uvwasi_fd_table_t;

typedef struct uvwasi_s {
  struct uvwasi_fd_table_t* fds;
  uvwasi_size_t argc;
  char** argv;
  char* argv_buf;
  uvwasi_size_t argv_buf_size;
  uvwasi_size_t envc;
  char** env;
  char* env_buf;
  uvwasi_size_t env_buf_size;
  const uvwasi_mem_t* allocator;
  uv_loop_t* loop;
} uvwasi_t;

typedef struct uvwasi_preopen_s {
  const char* mapped_path;
  const char* real_path;
} uvwasi_preopen_t;

typedef struct uvwasi_preopen_socket_s {
  const char* address;
  int port;
} uvwasi_preopen_socket_t;

typedef struct uvwasi_options_s {
  uvwasi_size_t fd_table_size;
  uvwasi_size_t preopenc;
  uvwasi_preopen_t* preopens;
  uvwasi_size_t preopen_socketc;
  uvwasi_preopen_socket_t* preopen_sockets;
  uvwasi_size_t argc;
  const char** argv;
  const char** envp;
  uvwasi_fd_t in;
  uvwasi_fd_t out;
  uvwasi_fd_t err;
  const uvwasi_mem_t* allocator;
} uvwasi_options_t;

/* Embedder API. */
UVWASI_EXPORT
uvwasi_errno_t uvwasi_init(uvwasi_t* uvwasi, const uvwasi_options_t* options);
UVWASI_EXPORT
void uvwasi_destroy(uvwasi_t* uvwasi);
UVWASI_EXPORT
void uvwasi_options_init(uvwasi_options_t* options);
/* Use int instead of uv_file to avoid needing uv.h */
UVWASI_EXPORT
uvwasi_errno_t uvwasi_embedder_remap_fd(uvwasi_t* uvwasi,
                                        const uvwasi_fd_t fd,
                                        int new_host_fd);
UVWASI_EXPORT
const char* uvwasi_embedder_err_code_to_string(uvwasi_errno_t code);


/* WASI system call API. */
UVWASI_EXPORT
uvwasi_errno_t uvwasi_args_get(uvwasi_t* uvwasi, char** argv, char* argv_buf);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_args_sizes_get(uvwasi_t* uvwasi,
                                     uvwasi_size_t* argc,
                                     uvwasi_size_t* argv_buf_size);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_clock_res_get(uvwasi_t* uvwasi,
                                    uvwasi_clockid_t clock_id,
                                    uvwasi_timestamp_t* resolution);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_clock_time_get(uvwasi_t* uvwasi,
                                     uvwasi_clockid_t clock_id,
                                     uvwasi_timestamp_t precision,
                                     uvwasi_timestamp_t* time);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_environ_get(uvwasi_t* uvwasi,
                                  char** environment,
                                  char* environ_buf);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_environ_sizes_get(uvwasi_t* uvwasi,
                                        uvwasi_size_t* environ_count,
                                        uvwasi_size_t* environ_buf_size);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_advise(uvwasi_t* uvwasi,
                                uvwasi_fd_t fd,
                                uvwasi_filesize_t offset,
                                uvwasi_filesize_t len,
                                uvwasi_advice_t advice);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_allocate(uvwasi_t* uvwasi,
                                  uvwasi_fd_t fd,
                                  uvwasi_filesize_t offset,
                                  uvwasi_filesize_t len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_close(uvwasi_t* uvwasi, uvwasi_fd_t fd);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_datasync(uvwasi_t* uvwasi, uvwasi_fd_t fd);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_fdstat_get(uvwasi_t* uvwasi,
                                    uvwasi_fd_t fd,
                                    uvwasi_fdstat_t* buf);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_fdstat_set_flags(uvwasi_t* uvwasi,
                                          uvwasi_fd_t fd,
                                          uvwasi_fdflags_t flags);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_fdstat_set_rights(uvwasi_t* uvwasi,
                                           uvwasi_fd_t fd,
                                           uvwasi_rights_t fs_rights_base,
                                           uvwasi_rights_t fs_rights_inheriting
                                          );
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_filestat_get(uvwasi_t* uvwasi,
                                      uvwasi_fd_t fd,
                                      uvwasi_filestat_t* buf);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_filestat_set_size(uvwasi_t* uvwasi,
                                           uvwasi_fd_t fd,
                                           uvwasi_filesize_t st_size);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_filestat_set_times(uvwasi_t* uvwasi,
                                            uvwasi_fd_t fd,
                                            uvwasi_timestamp_t st_atim,
                                            uvwasi_timestamp_t st_mtim,
                                            uvwasi_fstflags_t fst_flags);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_pread(uvwasi_t* uvwasi,
                               uvwasi_fd_t fd,
                               const uvwasi_iovec_t* iovs,
                               uvwasi_size_t iovs_len,
                               uvwasi_filesize_t offset,
                               uvwasi_size_t* nread);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_prestat_get(uvwasi_t* uvwasi,
                                     uvwasi_fd_t fd,
                                     uvwasi_prestat_t* buf);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_prestat_dir_name(uvwasi_t* uvwasi,
                                          uvwasi_fd_t fd,
                                          char* path,
                                          uvwasi_size_t path_len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_pwrite(uvwasi_t* uvwasi,
                                uvwasi_fd_t fd,
                                const uvwasi_ciovec_t* iovs,
                                uvwasi_size_t iovs_len,
                                uvwasi_filesize_t offset,
                                uvwasi_size_t* nwritten);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_read(uvwasi_t* uvwasi,
                              uvwasi_fd_t fd,
                              const uvwasi_iovec_t* iovs,
                              uvwasi_size_t iovs_len,
                              uvwasi_size_t* nread);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_readdir(uvwasi_t* uvwasi,
                                 uvwasi_fd_t fd,
                                 void* buf,
                                 uvwasi_size_t buf_len,
                                 uvwasi_dircookie_t cookie,
                                 uvwasi_size_t* bufused);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_renumber(uvwasi_t* uvwasi,
                                  uvwasi_fd_t from,
                                  uvwasi_fd_t to);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_seek(uvwasi_t* uvwasi,
                              uvwasi_fd_t fd,
                              uvwasi_filedelta_t offset,
                              uvwasi_whence_t whence,
                              uvwasi_filesize_t* newoffset);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_sync(uvwasi_t* uvwasi, uvwasi_fd_t fd);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_tell(uvwasi_t* uvwasi,
                              uvwasi_fd_t fd,
                              uvwasi_filesize_t* offset);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_fd_write(uvwasi_t* uvwasi,
                               uvwasi_fd_t fd,
                               const uvwasi_ciovec_t* iovs,
                               uvwasi_size_t iovs_len,
                               uvwasi_size_t* nwritten);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_create_directory(uvwasi_t* uvwasi,
                                            uvwasi_fd_t fd,
                                            const char* path,
                                            uvwasi_size_t path_len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_filestat_get(uvwasi_t* uvwasi,
                                        uvwasi_fd_t fd,
                                        uvwasi_lookupflags_t flags,
                                        const char* path,
                                        uvwasi_size_t path_len,
                                        uvwasi_filestat_t* buf);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_filestat_set_times(uvwasi_t* uvwasi,
                                              uvwasi_fd_t fd,
                                              uvwasi_lookupflags_t flags,
                                              const char* path,
                                              uvwasi_size_t path_len,
                                              uvwasi_timestamp_t st_atim,
                                              uvwasi_timestamp_t st_mtim,
                                              uvwasi_fstflags_t fst_flags);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_link(uvwasi_t* uvwasi,
                                uvwasi_fd_t old_fd,
                                uvwasi_lookupflags_t old_flags,
                                const char* old_path,
                                uvwasi_size_t old_path_len,
                                uvwasi_fd_t new_fd,
                                const char* new_path,
                                uvwasi_size_t new_path_len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_open(uvwasi_t* uvwasi,
                                uvwasi_fd_t dirfd,
                                uvwasi_lookupflags_t dirflags,
                                const char* path,
                                uvwasi_size_t path_len,
                                uvwasi_oflags_t o_flags,
                                uvwasi_rights_t fs_rights_base,
                                uvwasi_rights_t fs_rights_inheriting,
                                uvwasi_fdflags_t fs_flags,
                                uvwasi_fd_t* fd);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_readlink(uvwasi_t* uvwasi,
                                    uvwasi_fd_t fd,
                                    const char* path,
                                    uvwasi_size_t path_len,
                                    char* buf,
                                    uvwasi_size_t buf_len,
                                    uvwasi_size_t* bufused);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_remove_directory(uvwasi_t* uvwasi,
                                            uvwasi_fd_t fd,
                                            const char* path,
                                            uvwasi_size_t path_len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_rename(uvwasi_t* uvwasi,
                                  uvwasi_fd_t old_fd,
                                  const char* old_path,
                                  uvwasi_size_t old_path_len,
                                  uvwasi_fd_t new_fd,
                                  const char* new_path,
                                  uvwasi_size_t new_path_len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_symlink(uvwasi_t* uvwasi,
                                   const char* old_path,
                                   uvwasi_size_t old_path_len,
                                   uvwasi_fd_t fd,
                                   const char* new_path,
                                   uvwasi_size_t new_path_len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_path_unlink_file(uvwasi_t* uvwasi,
                                       uvwasi_fd_t fd,
                                       const char* path,
                                       uvwasi_size_t path_len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_poll_oneoff(uvwasi_t* uvwasi,
                                  const uvwasi_subscription_t* in,
                                  uvwasi_event_t* out,
                                  uvwasi_size_t nsubscriptions,
                                  uvwasi_size_t* nevents);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_proc_exit(uvwasi_t* uvwasi, uvwasi_exitcode_t rval);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_proc_raise(uvwasi_t* uvwasi, uvwasi_signal_t sig);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_random_get(uvwasi_t* uvwasi,
                                 void* buf,
                                 uvwasi_size_t buf_len);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_sched_yield(uvwasi_t* uvwasi);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_sock_accept(uvwasi_t* uvwasi,
                                  uvwasi_fd_t sock,
                                  uvwasi_fdflags_t flags,
                                  uvwasi_fd_t* fd);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_sock_recv(uvwasi_t* uvwasi,
                                uvwasi_fd_t sock,
                                const uvwasi_iovec_t* ri_data,
                                uvwasi_size_t ri_data_len,
                                uvwasi_riflags_t ri_flags,
                                uvwasi_size_t* ro_datalen,
                                uvwasi_roflags_t* ro_flags);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_sock_send(uvwasi_t* uvwasi,
                                uvwasi_fd_t sock,
                                const uvwasi_ciovec_t* si_data,
                                uvwasi_size_t si_data_len,
                                uvwasi_siflags_t si_flags,
                                uvwasi_size_t* so_datalen);
UVWASI_EXPORT
uvwasi_errno_t uvwasi_sock_shutdown(uvwasi_t* uvwasi,
                                    uvwasi_fd_t sock,
                                    uvwasi_sdflags_t how);

#ifdef __cplusplus
}
#endif

#endif /* __UVWASI_H__ */
