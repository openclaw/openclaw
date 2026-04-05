/* Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

/* See https://github.com/libuv/libuv#documentation for documentation. */

#ifndef UV_H
#define UV_H
#ifdef __cplusplus
extern "C" {
#endif

#if defined(BUILDING_UV_SHARED) && defined(USING_UV_SHARED)
#error "Define either BUILDING_UV_SHARED or USING_UV_SHARED, not both."
#endif

#ifndef UV_EXTERN
#ifdef _WIN32
  /* Windows - set up dll import/export decorators. */
# if defined(BUILDING_UV_SHARED)
    /* Building shared library. */
#   define UV_EXTERN __declspec(dllexport)
# elif defined(USING_UV_SHARED)
    /* Using shared library. */
#   define UV_EXTERN __declspec(dllimport)
# else
    /* Building static library. */
#   define UV_EXTERN /* nothing */
# endif
#elif defined(__GNUC__)
# define UV_EXTERN __attribute__((visibility("default")))
#else
# define UV_EXTERN /* nothing */
#endif
#endif /* UV_EXTERN */

#include "uv/errno.h"
#include "uv/version.h"
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>
#include <math.h>

/* Internal type, do not use. */
struct uv__queue {
  struct uv__queue* next;
  struct uv__queue* prev;
};

#if defined(_WIN32)
# include "uv/win.h"
#else
# include "uv/unix.h"
#endif

/* Expand this list if necessary. */
#define UV_ERRNO_MAP(XX)                                                      \
  XX(E2BIG, "argument list too long")                                         \
  XX(EACCES, "permission denied")                                             \
  XX(EADDRINUSE, "address already in use")                                    \
  XX(EADDRNOTAVAIL, "address not available")                                  \
  XX(EAFNOSUPPORT, "address family not supported")                            \
  XX(EAGAIN, "resource temporarily unavailable")                              \
  XX(EAI_ADDRFAMILY, "address family not supported")                          \
  XX(EAI_AGAIN, "temporary failure")                                          \
  XX(EAI_BADFLAGS, "bad ai_flags value")                                      \
  XX(EAI_BADHINTS, "invalid value for hints")                                 \
  XX(EAI_CANCELED, "request canceled")                                        \
  XX(EAI_FAIL, "permanent failure")                                           \
  XX(EAI_FAMILY, "ai_family not supported")                                   \
  XX(EAI_MEMORY, "out of memory")                                             \
  XX(EAI_NODATA, "no address")                                                \
  XX(EAI_NONAME, "unknown node or service")                                   \
  XX(EAI_OVERFLOW, "argument buffer overflow")                                \
  XX(EAI_PROTOCOL, "resolved protocol is unknown")                            \
  XX(EAI_SERVICE, "service not available for socket type")                    \
  XX(EAI_SOCKTYPE, "socket type not supported")                               \
  XX(EALREADY, "connection already in progress")                              \
  XX(EBADF, "bad file descriptor")                                            \
  XX(EBUSY, "resource busy or locked")                                        \
  XX(ECANCELED, "operation canceled")                                         \
  XX(ECHARSET, "invalid Unicode character")                                   \
  XX(ECONNABORTED, "software caused connection abort")                        \
  XX(ECONNREFUSED, "connection refused")                                      \
  XX(ECONNRESET, "connection reset by peer")                                  \
  XX(EDESTADDRREQ, "destination address required")                            \
  XX(EEXIST, "file already exists")                                           \
  XX(EFAULT, "bad address in system call argument")                           \
  XX(EFBIG, "file too large")                                                 \
  XX(EHOSTUNREACH, "host is unreachable")                                     \
  XX(EINTR, "interrupted system call")                                        \
  XX(EINVAL, "invalid argument")                                              \
  XX(EIO, "i/o error")                                                        \
  XX(EISCONN, "socket is already connected")                                  \
  XX(EISDIR, "illegal operation on a directory")                              \
  XX(ELOOP, "too many symbolic links encountered")                            \
  XX(EMFILE, "too many open files")                                           \
  XX(EMSGSIZE, "message too long")                                            \
  XX(ENAMETOOLONG, "name too long")                                           \
  XX(ENETDOWN, "network is down")                                             \
  XX(ENETUNREACH, "network is unreachable")                                   \
  XX(ENFILE, "file table overflow")                                           \
  XX(ENOBUFS, "no buffer space available")                                    \
  XX(ENODEV, "no such device")                                                \
  XX(ENOENT, "no such file or directory")                                     \
  XX(ENOMEM, "not enough memory")                                             \
  XX(ENONET, "machine is not on the network")                                 \
  XX(ENOPROTOOPT, "protocol not available")                                   \
  XX(ENOSPC, "no space left on device")                                       \
  XX(ENOSYS, "function not implemented")                                      \
  XX(ENOTCONN, "socket is not connected")                                     \
  XX(ENOTDIR, "not a directory")                                              \
  XX(ENOTEMPTY, "directory not empty")                                        \
  XX(ENOTSOCK, "socket operation on non-socket")                              \
  XX(ENOTSUP, "operation not supported on socket")                            \
  XX(EOVERFLOW, "value too large for defined data type")                      \
  XX(EPERM, "operation not permitted")                                        \
  XX(EPIPE, "broken pipe")                                                    \
  XX(EPROTO, "protocol error")                                                \
  XX(EPROTONOSUPPORT, "protocol not supported")                               \
  XX(EPROTOTYPE, "protocol wrong type for socket")                            \
  XX(ERANGE, "result too large")                                              \
  XX(EROFS, "read-only file system")                                          \
  XX(ESHUTDOWN, "cannot send after transport endpoint shutdown")              \
  XX(ESPIPE, "invalid seek")                                                  \
  XX(ESRCH, "no such process")                                                \
  XX(ETIMEDOUT, "connection timed out")                                       \
  XX(ETXTBSY, "text file is busy")                                            \
  XX(EXDEV, "cross-device link not permitted")                                \
  XX(UNKNOWN, "unknown error")                                                \
  XX(EOF, "end of file")                                                      \
  XX(ENXIO, "no such device or address")                                      \
  XX(EMLINK, "too many links")                                                \
  XX(EHOSTDOWN, "host is down")                                               \
  XX(EREMOTEIO, "remote I/O error")                                           \
  XX(ENOTTY, "inappropriate ioctl for device")                                \
  XX(EFTYPE, "inappropriate file type or format")                             \
  XX(EILSEQ, "illegal byte sequence")                                         \
  XX(ESOCKTNOSUPPORT, "socket type not supported")                            \
  XX(ENODATA, "no data available")                                            \
  XX(EUNATCH, "protocol driver not attached")                                 \
  XX(ENOEXEC, "exec format error")                                            \

#define UV_HANDLE_TYPE_MAP(XX)                                                \
  XX(ASYNC, async)                                                            \
  XX(CHECK, check)                                                            \
  XX(FS_EVENT, fs_event)                                                      \
  XX(FS_POLL, fs_poll)                                                        \
  XX(HANDLE, handle)                                                          \
  XX(IDLE, idle)                                                              \
  XX(NAMED_PIPE, pipe)                                                        \
  XX(POLL, poll)                                                              \
  XX(PREPARE, prepare)                                                        \
  XX(PROCESS, process)                                                        \
  XX(STREAM, stream)                                                          \
  XX(TCP, tcp)                                                                \
  XX(TIMER, timer)                                                            \
  XX(TTY, tty)                                                                \
  XX(UDP, udp)                                                                \
  XX(SIGNAL, signal)                                                          \

#define UV_REQ_TYPE_MAP(XX)                                                   \
  XX(REQ, req)                                                                \
  XX(CONNECT, connect)                                                        \
  XX(WRITE, write)                                                            \
  XX(SHUTDOWN, shutdown)                                                      \
  XX(UDP_SEND, udp_send)                                                      \
  XX(FS, fs)                                                                  \
  XX(WORK, work)                                                              \
  XX(GETADDRINFO, getaddrinfo)                                                \
  XX(GETNAMEINFO, getnameinfo)                                                \
  XX(RANDOM, random)                                                          \

typedef enum {
#define XX(code, _) UV_ ## code = UV__ ## code,
  UV_ERRNO_MAP(XX)
#undef XX
  UV_ERRNO_MAX = UV__EOF - 1
} uv_errno_t;

typedef enum {
  UV_UNKNOWN_HANDLE = 0,
#define XX(uc, lc) UV_##uc,
  UV_HANDLE_TYPE_MAP(XX)
#undef XX
  UV_FILE,
  UV_HANDLE_TYPE_MAX
} uv_handle_type;

typedef enum {
  UV_UNKNOWN_REQ = 0,
#define XX(uc, lc) UV_##uc,
  UV_REQ_TYPE_MAP(XX)
#undef XX
  UV_REQ_TYPE_PRIVATE
  UV_REQ_TYPE_MAX
} uv_req_type;


/* Handle types. */
typedef struct uv_loop_s uv_loop_t;
typedef struct uv_handle_s uv_handle_t;
typedef struct uv_dir_s uv_dir_t;
typedef struct uv_stream_s uv_stream_t;
typedef struct uv_tcp_s uv_tcp_t;
typedef struct uv_udp_s uv_udp_t;
typedef struct uv_pipe_s uv_pipe_t;
typedef struct uv_tty_s uv_tty_t;
typedef struct uv_poll_s uv_poll_t;
typedef struct uv_timer_s uv_timer_t;
typedef struct uv_prepare_s uv_prepare_t;
typedef struct uv_check_s uv_check_t;
typedef struct uv_idle_s uv_idle_t;
typedef struct uv_async_s uv_async_t;
typedef struct uv_process_s uv_process_t;
typedef struct uv_fs_event_s uv_fs_event_t;
typedef struct uv_fs_poll_s uv_fs_poll_t;
typedef struct uv_signal_s uv_signal_t;

/* Request types. */
typedef struct uv_req_s uv_req_t;
typedef struct uv_getaddrinfo_s uv_getaddrinfo_t;
typedef struct uv_getnameinfo_s uv_getnameinfo_t;
typedef struct uv_shutdown_s uv_shutdown_t;
typedef struct uv_write_s uv_write_t;
typedef struct uv_connect_s uv_connect_t;
typedef struct uv_udp_send_s uv_udp_send_t;
typedef struct uv_fs_s uv_fs_t;
typedef struct uv_work_s uv_work_t;
typedef struct uv_random_s uv_random_t;

/* None of the above. */
typedef struct uv_env_item_s uv_env_item_t;
typedef struct uv_cpu_info_s uv_cpu_info_t;
typedef struct uv_interface_address_s uv_interface_address_t;
typedef struct uv_dirent_s uv_dirent_t;
typedef struct uv_passwd_s uv_passwd_t;
typedef struct uv_group_s uv_group_t;
typedef struct uv_utsname_s uv_utsname_t;
typedef struct uv_statfs_s uv_statfs_t;

typedef struct uv_metrics_s uv_metrics_t;

typedef enum {
  UV_LOOP_BLOCK_SIGNAL = 0,
  UV_METRICS_IDLE_TIME,
  UV_LOOP_USE_IO_URING_SQPOLL
#define UV_LOOP_USE_IO_URING_SQPOLL UV_LOOP_USE_IO_URING_SQPOLL
} uv_loop_option;

typedef enum {
  UV_RUN_DEFAULT = 0,
  UV_RUN_ONCE,
  UV_RUN_NOWAIT
} uv_run_mode;


UV_EXTERN unsigned int uv_version(void);
UV_EXTERN const char* uv_version_string(void);

typedef void* (*uv_malloc_func)(size_t size);
typedef void* (*uv_realloc_func)(void* ptr, size_t size);
typedef void* (*uv_calloc_func)(size_t count, size_t size);
typedef void (*uv_free_func)(void* ptr);

UV_EXTERN void uv_library_shutdown(void);

UV_EXTERN int uv_replace_allocator(uv_malloc_func malloc_func,
                                   uv_realloc_func realloc_func,
                                   uv_calloc_func calloc_func,
                                   uv_free_func free_func);

UV_EXTERN uv_loop_t* uv_default_loop(void);
UV_EXTERN int uv_loop_init(uv_loop_t* loop);
UV_EXTERN int uv_loop_close(uv_loop_t* loop);
/*
 * NOTE:
 *  This function is DEPRECATED, users should
 *  allocate the loop manually and use uv_loop_init instead.
 */
UV_EXTERN uv_loop_t* uv_loop_new(void);
/*
 * NOTE:
 *  This function is DEPRECATED. Users should use
 *  uv_loop_close and free the memory manually instead.
 */
UV_EXTERN void uv_loop_delete(uv_loop_t*);
UV_EXTERN size_t uv_loop_size(void);
UV_EXTERN int uv_loop_alive(const uv_loop_t* loop);
UV_EXTERN int uv_loop_configure(uv_loop_t* loop, uv_loop_option option, ...);
UV_EXTERN int uv_loop_fork(uv_loop_t* loop);

UV_EXTERN int uv_run(uv_loop_t*, uv_run_mode mode);
UV_EXTERN void uv_stop(uv_loop_t*);

UV_EXTERN void uv_ref(uv_handle_t*);
UV_EXTERN void uv_unref(uv_handle_t*);
UV_EXTERN int uv_has_ref(const uv_handle_t*);

UV_EXTERN void uv_update_time(uv_loop_t*);
UV_EXTERN uint64_t uv_now(const uv_loop_t*);

UV_EXTERN int uv_backend_fd(const uv_loop_t*);
UV_EXTERN int uv_backend_timeout(const uv_loop_t*);

typedef void (*uv_alloc_cb)(uv_handle_t* handle,
                            size_t suggested_size,
                            uv_buf_t* buf);
typedef void (*uv_read_cb)(uv_stream_t* stream,
                           ssize_t nread,
                           const uv_buf_t* buf);
typedef void (*uv_write_cb)(uv_write_t* req, int status);
typedef void (*uv_connect_cb)(uv_connect_t* req, int status);
typedef void (*uv_shutdown_cb)(uv_shutdown_t* req, int status);
typedef void (*uv_connection_cb)(uv_stream_t* server, int status);
typedef void (*uv_close_cb)(uv_handle_t* handle);
typedef void (*uv_poll_cb)(uv_poll_t* handle, int status, int events);
typedef void (*uv_timer_cb)(uv_timer_t* handle);
typedef void (*uv_async_cb)(uv_async_t* handle);
typedef void (*uv_prepare_cb)(uv_prepare_t* handle);
typedef void (*uv_check_cb)(uv_check_t* handle);
typedef void (*uv_idle_cb)(uv_idle_t* handle);
typedef void (*uv_exit_cb)(uv_process_t*, int64_t exit_status, int term_signal);
typedef void (*uv_walk_cb)(uv_handle_t* handle, void* arg);
typedef void (*uv_fs_cb)(uv_fs_t* req);
typedef void (*uv_work_cb)(uv_work_t* req);
typedef void (*uv_after_work_cb)(uv_work_t* req, int status);
typedef void (*uv_getaddrinfo_cb)(uv_getaddrinfo_t* req,
                                  int status,
                                  struct addrinfo* res);
typedef void (*uv_getnameinfo_cb)(uv_getnameinfo_t* req,
                                  int status,
                                  const char* hostname,
                                  const char* service);
typedef void (*uv_random_cb)(uv_random_t* req,
                             int status,
                             void* buf,
                             size_t buflen);

typedef enum {
  UV_CLOCK_MONOTONIC,
  UV_CLOCK_REALTIME
} uv_clock_id;

/* XXX(bnoordhuis) not 2038-proof, https://github.com/libuv/libuv/issues/3864 */
typedef struct {
  long tv_sec;
  long tv_nsec;
} uv_timespec_t;

typedef struct {
  int64_t tv_sec;
  int32_t tv_nsec;
} uv_timespec64_t;

/* XXX(bnoordhuis) not 2038-proof, https://github.com/libuv/libuv/issues/3864 */
typedef struct {
  long tv_sec;
  long tv_usec;
} uv_timeval_t;

typedef struct {
  int64_t tv_sec;
  int32_t tv_usec;
} uv_timeval64_t;

typedef struct {
  uint64_t st_dev;
  uint64_t st_mode;
  uint64_t st_nlink;
  uint64_t st_uid;
  uint64_t st_gid;
  uint64_t st_rdev;
  uint64_t st_ino;
  uint64_t st_size;
  uint64_t st_blksize;
  uint64_t st_blocks;
  uint64_t st_flags;
  uint64_t st_gen;
  uv_timespec_t st_atim;
  uv_timespec_t st_mtim;
  uv_timespec_t st_ctim;
  uv_timespec_t st_birthtim;
} uv_stat_t;


typedef void (*uv_fs_event_cb)(uv_fs_event_t* handle,
                               const char* filename,
                               int events,
                               int status);

typedef void (*uv_fs_poll_cb)(uv_fs_poll_t* handle,
                              int status,
                              const uv_stat_t* prev,
                              const uv_stat_t* curr);

typedef void (*uv_signal_cb)(uv_signal_t* handle, int signum);


typedef enum {
  UV_LEAVE_GROUP = 0,
  UV_JOIN_GROUP
} uv_membership;


UV_EXTERN int uv_translate_sys_error(int sys_errno);

UV_EXTERN const char* uv_strerror(int err);
UV_EXTERN char* uv_strerror_r(int err, char* buf, size_t buflen);

UV_EXTERN const char* uv_err_name(int err);
UV_EXTERN char* uv_err_name_r(int err, char* buf, size_t buflen);


#define UV_REQ_FIELDS                                                         \
  /* public */                                                                \
  void* data;                                                                 \
  /* read-only */                                                             \
  uv_req_type type;                                                           \
  /* private */                                                               \
  void* reserved[6];                                                          \
  UV_REQ_PRIVATE_FIELDS                                                       \

/* Abstract base class of all requests. */
struct uv_req_s {
  UV_REQ_FIELDS
};


/* Platform-specific request types. */
UV_PRIVATE_REQ_TYPES


UV_EXTERN int uv_shutdown(uv_shutdown_t* req,
                          uv_stream_t* handle,
                          uv_shutdown_cb cb);

struct uv_shutdown_s {
  UV_REQ_FIELDS
  uv_stream_t* handle;
  uv_shutdown_cb cb;
  UV_SHUTDOWN_PRIVATE_FIELDS
};


#define UV_HANDLE_FIELDS                                                      \
  /* public */                                                                \
  void* data;                                                                 \
  /* read-only */                                                             \
  uv_loop_t* loop;                                                            \
  uv_handle_type type;                                                        \
  /* private */                                                               \
  uv_close_cb close_cb;                                                       \
  struct uv__queue handle_queue;                                              \
  union {                                                                     \
    int fd;                                                                   \
    void* reserved[4];                                                        \
  } u;                                                                        \
  UV_HANDLE_PRIVATE_FIELDS                                                    \

/* The abstract base class of all handles. */
struct uv_handle_s {
  UV_HANDLE_FIELDS
};

UV_EXTERN size_t uv_handle_size(uv_handle_type type);
UV_EXTERN uv_handle_type uv_handle_get_type(const uv_handle_t* handle);
UV_EXTERN const char* uv_handle_type_name(uv_handle_type type);
UV_EXTERN void* uv_handle_get_data(const uv_handle_t* handle);
UV_EXTERN uv_loop_t* uv_handle_get_loop(const uv_handle_t* handle);
UV_EXTERN void uv_handle_set_data(uv_handle_t* handle, void* data);

UV_EXTERN size_t uv_req_size(uv_req_type type);
UV_EXTERN void* uv_req_get_data(const uv_req_t* req);
UV_EXTERN void uv_req_set_data(uv_req_t* req, void* data);
UV_EXTERN uv_req_type uv_req_get_type(const uv_req_t* req);
UV_EXTERN const char* uv_req_type_name(uv_req_type type);

UV_EXTERN int uv_is_active(const uv_handle_t* handle);

UV_EXTERN void uv_walk(uv_loop_t* loop, uv_walk_cb walk_cb, void* arg);

/* Helpers for ad hoc debugging, no API/ABI stability guaranteed. */
UV_EXTERN void uv_print_all_handles(uv_loop_t* loop, FILE* stream);
UV_EXTERN void uv_print_active_handles(uv_loop_t* loop, FILE* stream);

UV_EXTERN void uv_close(uv_handle_t* handle, uv_close_cb close_cb);

UV_EXTERN int uv_send_buffer_size(uv_handle_t* handle, int* value);
UV_EXTERN int uv_recv_buffer_size(uv_handle_t* handle, int* value);

UV_EXTERN int uv_fileno(const uv_handle_t* handle, uv_os_fd_t* fd);

UV_EXTERN uv_buf_t uv_buf_init(char* base, unsigned int len);

UV_EXTERN int uv_pipe(uv_file fds[2], int read_flags, int write_flags);
UV_EXTERN int uv_socketpair(int type,
                            int protocol,
                            uv_os_sock_t socket_vector[2],
                            int flags0,
                            int flags1);

#define UV_STREAM_FIELDS                                                      \
  /* number of bytes queued for writing */                                    \
  size_t write_queue_size;                                                    \
  uv_alloc_cb alloc_cb;                                                       \
  uv_read_cb read_cb;                                                         \
  /* private */                                                               \
  UV_STREAM_PRIVATE_FIELDS

/*
 * uv_stream_t is a subclass of uv_handle_t.
 *
 * uv_stream is an abstract class.
 *
 * uv_stream_t is the parent class of uv_tcp_t, uv_pipe_t and uv_tty_t.
 */
struct uv_stream_s {
  UV_HANDLE_FIELDS
  UV_STREAM_FIELDS
};

UV_EXTERN size_t uv_stream_get_write_queue_size(const uv_stream_t* stream);

UV_EXTERN int uv_listen(uv_stream_t* stream, int backlog, uv_connection_cb cb);
UV_EXTERN int uv_accept(uv_stream_t* server, uv_stream_t* client);

UV_EXTERN int uv_read_start(uv_stream_t*,
                            uv_alloc_cb alloc_cb,
                            uv_read_cb read_cb);
UV_EXTERN int uv_read_stop(uv_stream_t*);

UV_EXTERN int uv_write(uv_write_t* req,
                       uv_stream_t* handle,
                       const uv_buf_t bufs[],
                       unsigned int nbufs,
                       uv_write_cb cb);
UV_EXTERN int uv_write2(uv_write_t* req,
                        uv_stream_t* handle,
                        const uv_buf_t bufs[],
                        unsigned int nbufs,
                        uv_stream_t* send_handle,
                        uv_write_cb cb);
UV_EXTERN int uv_try_write(uv_stream_t* handle,
                           const uv_buf_t bufs[],
                           unsigned int nbufs);
UV_EXTERN int uv_try_write2(uv_stream_t* handle,
                            const uv_buf_t bufs[],
                            unsigned int nbufs,
                            uv_stream_t* send_handle);

/* uv_write_t is a subclass of uv_req_t. */
struct uv_write_s {
  UV_REQ_FIELDS
  uv_write_cb cb;
  uv_stream_t* send_handle; /* TODO: make private and unix-only in v2.x. */
  uv_stream_t* handle;
  UV_WRITE_PRIVATE_FIELDS
};


UV_EXTERN int uv_is_readable(const uv_stream_t* handle);
UV_EXTERN int uv_is_writable(const uv_stream_t* handle);

UV_EXTERN int uv_stream_set_blocking(uv_stream_t* handle, int blocking);

UV_EXTERN int uv_is_closing(const uv_handle_t* handle);


/*
 * uv_tcp_t is a subclass of uv_stream_t.
 *
 * Represents a TCP stream or TCP server.
 */
struct uv_tcp_s {
  UV_HANDLE_FIELDS
  UV_STREAM_FIELDS
  UV_TCP_PRIVATE_FIELDS
};

UV_EXTERN int uv_tcp_init(uv_loop_t*, uv_tcp_t* handle);
UV_EXTERN int uv_tcp_init_ex(uv_loop_t*, uv_tcp_t* handle, unsigned int flags);
UV_EXTERN int uv_tcp_open(uv_tcp_t* handle, uv_os_sock_t sock);
UV_EXTERN int uv_tcp_nodelay(uv_tcp_t* handle, int enable);
UV_EXTERN int uv_tcp_keepalive(uv_tcp_t* handle,
                               int enable,
                               unsigned int delay);
UV_EXTERN int uv_tcp_keepalive_ex(uv_tcp_t* handle,
                                  int on,
                                  unsigned int idle,
                                  unsigned int intvl,
                                  unsigned int cnt);
UV_EXTERN int uv_tcp_simultaneous_accepts(uv_tcp_t* handle, int enable);

enum uv_tcp_flags {
  /* Used with uv_tcp_bind, when an IPv6 address is used. */
  UV_TCP_IPV6ONLY = 1,

  /* Enable SO_REUSEPORT socket option when binding the handle.
   * This allows completely duplicate bindings by multiple processes
   * or threads if they all set SO_REUSEPORT before binding the port.
   * Incoming connections are distributed across the participating
   * listener sockets.
   *
   * This flag is available only on Linux 3.9+, DragonFlyBSD 3.6+,
   * FreeBSD 12.0+, Solaris 11.4, and AIX 7.2.5+ for now.
   */
  UV_TCP_REUSEPORT = 2,
};

UV_EXTERN int uv_tcp_bind(uv_tcp_t* handle,
                          const struct sockaddr* addr,
                          unsigned int flags);
UV_EXTERN int uv_tcp_getsockname(const uv_tcp_t* handle,
                                 struct sockaddr* name,
                                 int* namelen);
UV_EXTERN int uv_tcp_getpeername(const uv_tcp_t* handle,
                                 struct sockaddr* name,
                                 int* namelen);
UV_EXTERN int uv_tcp_close_reset(uv_tcp_t* handle, uv_close_cb close_cb);
UV_EXTERN int uv_tcp_connect(uv_connect_t* req,
                             uv_tcp_t* handle,
                             const struct sockaddr* addr,
                             uv_connect_cb cb);

/* uv_connect_t is a subclass of uv_req_t. */
struct uv_connect_s {
  UV_REQ_FIELDS
  uv_connect_cb cb;
  uv_stream_t* handle;
  UV_CONNECT_PRIVATE_FIELDS
};


/*
 * UDP support.
 */

enum uv_udp_flags {
  /* Disables dual stack mode. */
  UV_UDP_IPV6ONLY = 1,
  /*
   * Indicates message was truncated because read buffer was too small. The
   * remainder was discarded by the OS. Used in uv_udp_recv_cb.
   */
  UV_UDP_PARTIAL = 2,
  /*
   * Indicates if SO_REUSEADDR will be set when binding the handle.
   * This sets the SO_REUSEPORT socket flag on the BSDs (except for
   * DragonFlyBSD), OS X, and other platforms where SO_REUSEPORTs don't
   * have the capability of load balancing, as the opposite of what
   * UV_UDP_REUSEPORT would do. On other Unix platforms, it sets the
   * SO_REUSEADDR flag. What that means is that multiple threads or
   * processes can bind to the same address without error (provided
   * they all set the flag) but only the last one to bind will receive
   * any traffic, in effect "stealing" the port from the previous listener.
   */
  UV_UDP_REUSEADDR = 4,
  /*
   * Indicates that the message was received by recvmmsg, so the buffer provided
   * must not be freed by the recv_cb callback.
   */
  UV_UDP_MMSG_CHUNK = 8,
  /*
   * Indicates that the buffer provided has been fully utilized by recvmmsg and
   * that it should now be freed by the recv_cb callback. When this flag is set
   * in uv_udp_recv_cb, nread will always be 0 and addr will always be NULL.
   */
  UV_UDP_MMSG_FREE = 16,
  /*
   * Indicates if IP_RECVERR/IPV6_RECVERR will be set when binding the handle.
   * This sets IP_RECVERR for IPv4 and IPV6_RECVERR for IPv6 UDP sockets on
   * Linux. This stops the Linux kernel from suppressing some ICMP error
   * messages and enables full ICMP error reporting for faster failover.
   * This flag is no-op on platforms other than Linux.
   */
  UV_UDP_LINUX_RECVERR = 32,
  /*
   * Indicates if SO_REUSEPORT will be set when binding the handle.
   * This sets the SO_REUSEPORT socket option on supported platforms.
   * Unlike UV_UDP_REUSEADDR, this flag will make multiple threads or
   * processes that are binding to the same address and port "share"
   * the port, which means incoming datagrams are distributed across
   * the receiving sockets among threads or processes.
   *
   * This flag is available only on Linux 3.9+, DragonFlyBSD 3.6+,
   * FreeBSD 12.0+, Solaris 11.4, and AIX 7.2.5+ for now.
   */
  UV_UDP_REUSEPORT = 64,
  /*
   * Indicates that recvmmsg should be used, if available.
   */
  UV_UDP_RECVMMSG = 256
};

typedef void (*uv_udp_send_cb)(uv_udp_send_t* req, int status);
typedef void (*uv_udp_recv_cb)(uv_udp_t* handle,
                               ssize_t nread,
                               const uv_buf_t* buf,
                               const struct sockaddr* addr,
                               unsigned flags);

/* uv_udp_t is a subclass of uv_handle_t. */
struct uv_udp_s {
  UV_HANDLE_FIELDS
  /* read-only */
  /*
   * Number of bytes queued for sending. This field strictly shows how much
   * information is currently queued.
   */
  size_t send_queue_size;
  /*
   * Number of send requests currently in the queue awaiting to be processed.
   */
  size_t send_queue_count;
  UV_UDP_PRIVATE_FIELDS
};

/* uv_udp_send_t is a subclass of uv_req_t. */
struct uv_udp_send_s {
  UV_REQ_FIELDS
  uv_udp_t* handle;
  uv_udp_send_cb cb;
  UV_UDP_SEND_PRIVATE_FIELDS
};

UV_EXTERN int uv_udp_init(uv_loop_t*, uv_udp_t* handle);
UV_EXTERN int uv_udp_init_ex(uv_loop_t*, uv_udp_t* handle, unsigned int flags);
UV_EXTERN int uv_udp_open(uv_udp_t* handle, uv_os_sock_t sock);
UV_EXTERN int uv_udp_open_ex(uv_udp_t* handle,
                             uv_os_sock_t sock,
                             unsigned int flags);
UV_EXTERN int uv_udp_bind(uv_udp_t* handle,
                          const struct sockaddr* addr,
                          unsigned int flags);
UV_EXTERN int uv_udp_connect(uv_udp_t* handle, const struct sockaddr* addr);

UV_EXTERN int uv_udp_getpeername(const uv_udp_t* handle,
                                 struct sockaddr* name,
                                 int* namelen);
UV_EXTERN int uv_udp_getsockname(const uv_udp_t* handle,
                                 struct sockaddr* name,
                                 int* namelen);
UV_EXTERN int uv_udp_set_membership(uv_udp_t* handle,
                                    const char* multicast_addr,
                                    const char* interface_addr,
                                    uv_membership membership);
UV_EXTERN int uv_udp_set_source_membership(uv_udp_t* handle,
                                           const char* multicast_addr,
                                           const char* interface_addr,
                                           const char* source_addr,
                                           uv_membership membership);
UV_EXTERN int uv_udp_set_multicast_loop(uv_udp_t* handle, int on);
UV_EXTERN int uv_udp_set_multicast_ttl(uv_udp_t* handle, int ttl);
UV_EXTERN int uv_udp_set_multicast_interface(uv_udp_t* handle,
                                             const char* interface_addr);
UV_EXTERN int uv_udp_set_broadcast(uv_udp_t* handle, int on);
UV_EXTERN int uv_udp_set_ttl(uv_udp_t* handle, int ttl);
UV_EXTERN int uv_udp_send(uv_udp_send_t* req,
                          uv_udp_t* handle,
                          const uv_buf_t bufs[],
                          unsigned int nbufs,
                          const struct sockaddr* addr,
                          uv_udp_send_cb send_cb);
UV_EXTERN int uv_udp_try_send(uv_udp_t* handle,
                              const uv_buf_t bufs[],
                              unsigned int nbufs,
                              const struct sockaddr* addr);
UV_EXTERN int uv_udp_try_send2(uv_udp_t* handle,
                               unsigned int count,
                               uv_buf_t* bufs[/*count*/],
                               unsigned int nbufs[/*count*/],
                               struct sockaddr* addrs[/*count*/],
                               unsigned int flags);
UV_EXTERN int uv_udp_recv_start(uv_udp_t* handle,
                                uv_alloc_cb alloc_cb,
                                uv_udp_recv_cb recv_cb);
UV_EXTERN int uv_udp_using_recvmmsg(const uv_udp_t* handle);
UV_EXTERN int uv_udp_recv_stop(uv_udp_t* handle);
UV_EXTERN size_t uv_udp_get_send_queue_size(const uv_udp_t* handle);
UV_EXTERN size_t uv_udp_get_send_queue_count(const uv_udp_t* handle);


/*
 * uv_tty_t is a subclass of uv_stream_t.
 *
 * Representing a stream for the console.
 */
struct uv_tty_s {
  UV_HANDLE_FIELDS
  UV_STREAM_FIELDS
  UV_TTY_PRIVATE_FIELDS
};

typedef enum {
  /* Initial/normal terminal mode */
  UV_TTY_MODE_NORMAL,
  /*
   * Raw input mode (On Windows, ENABLE_WINDOW_INPUT is also enabled).
   * May become equivalent to UV_TTY_MODE_RAW_VT in future libuv versions.
   */
  UV_TTY_MODE_RAW,
  /* Binary-safe I/O mode for IPC (Unix-only) */
  UV_TTY_MODE_IO,
  /* Raw input mode. On Windows ENABLE_VIRTUAL_TERMINAL_INPUT is also set. */
  UV_TTY_MODE_RAW_VT
} uv_tty_mode_t;

typedef enum {
  /*
   * The console supports handling of virtual terminal sequences
   * (Windows10 new console, ConEmu)
   */
  UV_TTY_SUPPORTED,
  /* The console cannot process the virtual terminal sequence.  (Legacy
   * console)
   */
  UV_TTY_UNSUPPORTED
} uv_tty_vtermstate_t;


UV_EXTERN int uv_tty_init(uv_loop_t*, uv_tty_t*, uv_file fd, int readable);
UV_EXTERN int uv_tty_set_mode(uv_tty_t*, uv_tty_mode_t mode);
UV_EXTERN int uv_tty_reset_mode(void);
UV_EXTERN int uv_tty_get_winsize(uv_tty_t*, int* width, int* height);
UV_EXTERN void uv_tty_set_vterm_state(uv_tty_vtermstate_t state);
UV_EXTERN int uv_tty_get_vterm_state(uv_tty_vtermstate_t* state);

#ifdef __cplusplus
extern "C++" {

inline int uv_tty_set_mode(uv_tty_t* handle, int mode) {
  return uv_tty_set_mode(handle, static_cast<uv_tty_mode_t>(mode));
}

}
#endif

UV_EXTERN uv_handle_type uv_guess_handle(uv_file file);

enum {
  UV_PIPE_NO_TRUNCATE = 1u << 0
};

/*
 * uv_pipe_t is a subclass of uv_stream_t.
 *
 * Representing a pipe stream or pipe server. On Windows this is a Named
 * Pipe. On Unix this is a Unix domain socket.
 */
struct uv_pipe_s {
  UV_HANDLE_FIELDS
  UV_STREAM_FIELDS
  int ipc; /* non-zero if this pipe is used for passing handles */
  UV_PIPE_PRIVATE_FIELDS
};

UV_EXTERN int uv_pipe_init(uv_loop_t*, uv_pipe_t* handle, int ipc);
UV_EXTERN int uv_pipe_open(uv_pipe_t*, uv_file file);
UV_EXTERN int uv_pipe_bind(uv_pipe_t* handle, const char* name);
UV_EXTERN int uv_pipe_bind2(uv_pipe_t* handle,
                            const char* name,
                            size_t namelen,
                            unsigned int flags);
UV_EXTERN void uv_pipe_connect(uv_connect_t* req,
                               uv_pipe_t* handle,
                               const char* name,
                               uv_connect_cb cb);
UV_EXTERN int uv_pipe_connect2(uv_connect_t* req,
                               uv_pipe_t* handle,
                               const char* name,
                               size_t namelen,
                               unsigned int flags,
                               uv_connect_cb cb);
UV_EXTERN int uv_pipe_getsockname(const uv_pipe_t* handle,
                                  char* buffer,
                                  size_t* size);
UV_EXTERN int uv_pipe_getpeername(const uv_pipe_t* handle,
                                  char* buffer,
                                  size_t* size);
UV_EXTERN void uv_pipe_pending_instances(uv_pipe_t* handle, int count);
UV_EXTERN int uv_pipe_pending_count(uv_pipe_t* handle);
UV_EXTERN uv_handle_type uv_pipe_pending_type(uv_pipe_t* handle);
UV_EXTERN int uv_pipe_chmod(uv_pipe_t* handle, int flags);


struct uv_poll_s {
  UV_HANDLE_FIELDS
  uv_poll_cb poll_cb;
  UV_POLL_PRIVATE_FIELDS
};

enum uv_poll_event {
  UV_READABLE = 1,
  UV_WRITABLE = 2,
  UV_DISCONNECT = 4,
  UV_PRIORITIZED = 8
};

UV_EXTERN int uv_poll_init(uv_loop_t* loop, uv_poll_t* handle, int fd);
UV_EXTERN int uv_poll_init_socket(uv_loop_t* loop,
                                  uv_poll_t* handle,
                                  uv_os_sock_t socket);
UV_EXTERN int uv_poll_start(uv_poll_t* handle, int events, uv_poll_cb cb);
UV_EXTERN int uv_poll_stop(uv_poll_t* handle);


struct uv_prepare_s {
  UV_HANDLE_FIELDS
  UV_PREPARE_PRIVATE_FIELDS
};

UV_EXTERN int uv_prepare_init(uv_loop_t*, uv_prepare_t* prepare);
UV_EXTERN int uv_prepare_start(uv_prepare_t* prepare, uv_prepare_cb cb);
UV_EXTERN int uv_prepare_stop(uv_prepare_t* prepare);


struct uv_check_s {
  UV_HANDLE_FIELDS
  UV_CHECK_PRIVATE_FIELDS
};

UV_EXTERN int uv_check_init(uv_loop_t*, uv_check_t* check);
UV_EXTERN int uv_check_start(uv_check_t* check, uv_check_cb cb);
UV_EXTERN int uv_check_stop(uv_check_t* check);


struct uv_idle_s {
  UV_HANDLE_FIELDS
  UV_IDLE_PRIVATE_FIELDS
};

UV_EXTERN int uv_idle_init(uv_loop_t*, uv_idle_t* idle);
UV_EXTERN int uv_idle_start(uv_idle_t* idle, uv_idle_cb cb);
UV_EXTERN int uv_idle_stop(uv_idle_t* idle);


struct uv_async_s {
  UV_HANDLE_FIELDS
  UV_ASYNC_PRIVATE_FIELDS
};

UV_EXTERN int uv_async_init(uv_loop_t*,
                            uv_async_t* async,
                            uv_async_cb async_cb);
UV_EXTERN int uv_async_send(uv_async_t* async);


/*
 * uv_timer_t is a subclass of uv_handle_t.
 *
 * Used to get woken up at a specified time in the future.
 */
struct uv_timer_s {
  UV_HANDLE_FIELDS
  UV_TIMER_PRIVATE_FIELDS
};

UV_EXTERN int uv_timer_init(uv_loop_t*, uv_timer_t* handle);
UV_EXTERN int uv_timer_start(uv_timer_t* handle,
                             uv_timer_cb cb,
                             uint64_t timeout,
                             uint64_t repeat);
UV_EXTERN int uv_timer_stop(uv_timer_t* handle);
UV_EXTERN int uv_timer_again(uv_timer_t* handle);
UV_EXTERN void uv_timer_set_repeat(uv_timer_t* handle, uint64_t repeat);
UV_EXTERN uint64_t uv_timer_get_repeat(const uv_timer_t* handle);
UV_EXTERN uint64_t uv_timer_get_due_in(const uv_timer_t* handle);


/*
 * uv_getaddrinfo_t is a subclass of uv_req_t.
 *
 * Request object for uv_getaddrinfo.
 */
struct uv_getaddrinfo_s {
  UV_REQ_FIELDS
  /* read-only */
  uv_loop_t* loop;
  /* struct addrinfo* addrinfo is marked as private, but it really isn't. */
  UV_GETADDRINFO_PRIVATE_FIELDS
};


UV_EXTERN int uv_getaddrinfo(uv_loop_t* loop,
                             uv_getaddrinfo_t* req,
                             uv_getaddrinfo_cb getaddrinfo_cb,
                             const char* node,
                             const char* service,
                             const struct addrinfo* hints);
UV_EXTERN void uv_freeaddrinfo(struct addrinfo* ai);


/*
* uv_getnameinfo_t is a subclass of uv_req_t.
*
* Request object for uv_getnameinfo.
*/
struct uv_getnameinfo_s {
  UV_REQ_FIELDS
  /* read-only */
  uv_loop_t* loop;
  /* host and service are marked as private, but they really aren't. */
  UV_GETNAMEINFO_PRIVATE_FIELDS
};

UV_EXTERN int uv_getnameinfo(uv_loop_t* loop,
                             uv_getnameinfo_t* req,
                             uv_getnameinfo_cb getnameinfo_cb,
                             const struct sockaddr* addr,
                             int flags);


/* uv_spawn() options. */
typedef enum {
  UV_IGNORE         = 0x00,
  UV_CREATE_PIPE    = 0x01,
  UV_INHERIT_FD     = 0x02,
  UV_INHERIT_STREAM = 0x04,

  /*
   * When UV_CREATE_PIPE is specified, UV_READABLE_PIPE and UV_WRITABLE_PIPE
   * determine the direction of flow, from the child process' perspective. Both
   * flags may be specified to create a duplex data stream.
   */
  UV_READABLE_PIPE  = 0x10,
  UV_WRITABLE_PIPE  = 0x20,

  /*
   * When UV_CREATE_PIPE is specified, specifying UV_NONBLOCK_PIPE opens the
   * handle in non-blocking mode in the child. This may cause loss of data,
   * if the child is not designed to handle to encounter this mode,
   * but can also be significantly more efficient.
   */
  UV_NONBLOCK_PIPE  = 0x40,
  UV_OVERLAPPED_PIPE = 0x40 /* old name, for compatibility */
} uv_stdio_flags;

typedef struct uv_stdio_container_s {
  uv_stdio_flags flags;

  union {
    uv_stream_t* stream;
    int fd;
  } data;
} uv_stdio_container_t;

typedef struct uv_process_options_s {
  uv_exit_cb exit_cb; /* Called after the process exits. */
  const char* file;   /* Path to program to execute. */
  /*
   * Command line arguments. args[0] should be the path to the program. On
   * Windows this uses CreateProcess which concatenates the arguments into a
   * string this can cause some strange errors. See the note at
   * windows_verbatim_arguments.
   */
  char** args;
  /*
   * This will be set as the environ variable in the subprocess. If this is
   * NULL then the parents environ will be used.
   */
  char** env;
  /*
   * If non-null this represents a directory the subprocess should execute
   * in. Stands for current working directory.
   */
  const char* cwd;
  /*
   * Various flags that control how uv_spawn() behaves. See the definition of
   * `enum uv_process_flags` below.
   */
  unsigned int flags;
  /*
   * The `stdio` field points to an array of uv_stdio_container_t structs that
   * describe the file descriptors that will be made available to the child
   * process. The convention is that stdio[0] points to stdin, fd 1 is used for
   * stdout, and fd 2 is stderr.
   *
   * Note that on windows file descriptors greater than 2 are available to the
   * child process only if the child processes uses the MSVCRT runtime.
   */
  int stdio_count;
  uv_stdio_container_t* stdio;
  /*
   * Libuv can change the child process' user/group id. This happens only when
   * the appropriate bits are set in the flags fields. This is not supported on
   * windows; uv_spawn() will fail and set the error to UV_ENOTSUP.
   */
  uv_uid_t uid;
  uv_gid_t gid;
} uv_process_options_t;

/*
 * These are the flags that can be used for the uv_process_options.flags field.
 */
enum uv_process_flags {
  /*
   * Set the child process' user id. The user id is supplied in the `uid` field
   * of the options struct. This does not work on windows; setting this flag
   * will cause uv_spawn() to fail.
   */
  UV_PROCESS_SETUID = (1 << 0),
  /*
   * Set the child process' group id. The user id is supplied in the `gid`
   * field of the options struct. This does not work on windows; setting this
   * flag will cause uv_spawn() to fail.
   */
  UV_PROCESS_SETGID = (1 << 1),
  /*
   * Do not wrap any arguments in quotes, or perform any other escaping, when
   * converting the argument list into a command line string. This option is
   * only meaningful on Windows systems. On Unix it is silently ignored.
   */
  UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS = (1 << 2),
  /*
   * Spawn the child process in a detached state - this will make it a process
   * group leader, and will effectively enable the child to keep running after
   * the parent exits.  Note that the child process will still keep the
   * parent's event loop alive unless the parent process calls uv_unref() on
   * the child's process handle.
   */
  UV_PROCESS_DETACHED = (1 << 3),
  /*
   * Hide the subprocess window that would normally be created. This option is
   * only meaningful on Windows systems. On Unix it is silently ignored.
   */
  UV_PROCESS_WINDOWS_HIDE = (1 << 4),
  /*
   * Hide the subprocess console window that would normally be created. This
   * option is only meaningful on Windows systems. On Unix it is silently
   * ignored.
   */
  UV_PROCESS_WINDOWS_HIDE_CONSOLE = (1 << 5),
  /*
   * Hide the subprocess GUI window that would normally be created. This
   * option is only meaningful on Windows systems. On Unix it is silently
   * ignored.
   */
  UV_PROCESS_WINDOWS_HIDE_GUI = (1 << 6),
  /*
   * On Windows, if the path to the program to execute, specified in
   * uv_process_options_t's file field, has a directory component,
   * search for the exact file name before trying variants with
   * extensions like '.exe' or '.cmd'.
   */
  UV_PROCESS_WINDOWS_FILE_PATH_EXACT_NAME = (1 << 7)
};

/*
 * uv_process_t is a subclass of uv_handle_t.
 */
struct uv_process_s {
  UV_HANDLE_FIELDS
  uv_exit_cb exit_cb;
  int pid;
  UV_PROCESS_PRIVATE_FIELDS
};

UV_EXTERN int uv_spawn(uv_loop_t* loop,
                       uv_process_t* handle,
                       const uv_process_options_t* options);
UV_EXTERN int uv_process_kill(uv_process_t*, int signum);
UV_EXTERN int uv_kill(int pid, int signum);
UV_EXTERN uv_pid_t uv_process_get_pid(const uv_process_t*);


/*
 * uv_work_t is a subclass of uv_req_t.
 */
struct uv_work_s {
  UV_REQ_FIELDS
  uv_loop_t* loop;
  uv_work_cb work_cb;
  uv_after_work_cb after_work_cb;
  UV_WORK_PRIVATE_FIELDS
};

UV_EXTERN int uv_queue_work(uv_loop_t* loop,
                            uv_work_t* req,
                            uv_work_cb work_cb,
                            uv_after_work_cb after_work_cb);

UV_EXTERN int uv_cancel(uv_req_t* req);


struct uv_cpu_times_s {
  uint64_t user; /* milliseconds */
  uint64_t nice; /* milliseconds */
  uint64_t sys; /* milliseconds */
  uint64_t idle; /* milliseconds */
  uint64_t irq; /* milliseconds */
};

struct uv_cpu_info_s {
  const char* model;
  int speed;
  struct uv_cpu_times_s cpu_times;
};

struct uv_interface_address_s {
  char* name;
  char phys_addr[6];
  int is_internal;
  union {
    struct sockaddr_in address4;
    struct sockaddr_in6 address6;
  } address;
  union {
    struct sockaddr_in netmask4;
    struct sockaddr_in6 netmask6;
  } netmask;
};

struct uv_passwd_s {
  char* username;
  unsigned long uid;
  unsigned long gid;
  char* shell;
  char* homedir;
};

struct uv_group_s {
  char* groupname;
  unsigned long gid;
  char** members;
};

struct uv_utsname_s {
  char sysname[256];
  char release[256];
  char version[256];
  char machine[256];
  /* This struct does not contain the nodename and domainname fields present in
     the utsname type. domainname is a GNU extension. Both fields are referred
     to as meaningless in the docs. */
};

struct uv_statfs_s {
  uint64_t f_type;
  uint64_t f_bsize;
  uint64_t f_blocks;
  uint64_t f_bfree;
  uint64_t f_bavail;
  uint64_t f_files;
  uint64_t f_ffree;
  uint64_t f_frsize;
  uint64_t f_spare[3];
};

typedef enum {
  UV_DIRENT_UNKNOWN,
  UV_DIRENT_FILE,
  UV_DIRENT_DIR,
  UV_DIRENT_LINK,
  UV_DIRENT_FIFO,
  UV_DIRENT_SOCKET,
  UV_DIRENT_CHAR,
  UV_DIRENT_BLOCK
} uv_dirent_type_t;

struct uv_dirent_s {
  const char* name;
  uv_dirent_type_t type;
};

UV_EXTERN char** uv_setup_args(int argc, char** argv);
UV_EXTERN int uv_get_process_title(char* buffer, size_t size);
UV_EXTERN int uv_set_process_title(const char* title);
UV_EXTERN int uv_resident_set_memory(size_t* rss);
UV_EXTERN int uv_uptime(double* uptime);
UV_EXTERN uv_os_fd_t uv_get_osfhandle(int fd);
UV_EXTERN int uv_open_osfhandle(uv_os_fd_t os_fd);

typedef struct {
   uv_timeval_t ru_utime; /* user CPU time used */
   uv_timeval_t ru_stime; /* system CPU time used */
   uint64_t ru_maxrss;    /* maximum resident set size */
   uint64_t ru_ixrss;     /* integral shared memory size */
   uint64_t ru_idrss;     /* integral unshared data size */
   uint64_t ru_isrss;     /* integral unshared stack size */
   uint64_t ru_minflt;    /* page reclaims (soft page faults) */
   uint64_t ru_majflt;    /* page faults (hard page faults) */
   uint64_t ru_nswap;     /* swaps */
   uint64_t ru_inblock;   /* block input operations */
   uint64_t ru_oublock;   /* block output operations */
   uint64_t ru_msgsnd;    /* IPC messages sent */
   uint64_t ru_msgrcv;    /* IPC messages received */
   uint64_t ru_nsignals;  /* signals received */
   uint64_t ru_nvcsw;     /* voluntary context switches */
   uint64_t ru_nivcsw;    /* involuntary context switches */
} uv_rusage_t;

UV_EXTERN int uv_getrusage(uv_rusage_t* rusage);
UV_EXTERN int uv_getrusage_thread(uv_rusage_t* rusage);

UV_EXTERN int uv_os_homedir(char* buffer, size_t* size);
UV_EXTERN int uv_os_tmpdir(char* buffer, size_t* size);
UV_EXTERN int uv_os_get_passwd(uv_passwd_t* pwd);
UV_EXTERN void uv_os_free_passwd(uv_passwd_t* pwd);
UV_EXTERN int uv_os_get_passwd2(uv_passwd_t* pwd, uv_uid_t uid);
UV_EXTERN int uv_os_get_group(uv_group_t* grp, uv_uid_t gid);
UV_EXTERN void uv_os_free_group(uv_group_t* grp);
UV_EXTERN uv_pid_t uv_os_getpid(void);
UV_EXTERN uv_pid_t uv_os_getppid(void);

#if defined(__PASE__)
/* On IBM i PASE, the highest process priority is -10 */
# define UV_PRIORITY_LOW 39          /* RUNPTY(99) */
# define UV_PRIORITY_BELOW_NORMAL 15 /* RUNPTY(50) */
# define UV_PRIORITY_NORMAL 0        /* RUNPTY(20) */
# define UV_PRIORITY_ABOVE_NORMAL -4 /* RUNTY(12) */
# define UV_PRIORITY_HIGH -7         /* RUNPTY(6) */
# define UV_PRIORITY_HIGHEST -10     /* RUNPTY(1) */
#else
# define UV_PRIORITY_LOW 19
# define UV_PRIORITY_BELOW_NORMAL 10
# define UV_PRIORITY_NORMAL 0
# define UV_PRIORITY_ABOVE_NORMAL -7
# define UV_PRIORITY_HIGH -14
# define UV_PRIORITY_HIGHEST -20
#endif

UV_EXTERN int uv_os_getpriority(uv_pid_t pid, int* priority);
UV_EXTERN int uv_os_setpriority(uv_pid_t pid, int priority);

enum {
  UV_THREAD_PRIORITY_HIGHEST = 2,
  UV_THREAD_PRIORITY_ABOVE_NORMAL = 1,
  UV_THREAD_PRIORITY_NORMAL = 0,
  UV_THREAD_PRIORITY_BELOW_NORMAL = -1,
  UV_THREAD_PRIORITY_LOWEST = -2,
};

UV_EXTERN int uv_thread_getpriority(uv_thread_t tid, int* priority);
UV_EXTERN int uv_thread_setpriority(uv_thread_t tid, int priority);

UV_EXTERN unsigned int uv_available_parallelism(void);
UV_EXTERN int uv_cpu_info(uv_cpu_info_t** cpu_infos, int* count);
UV_EXTERN void uv_free_cpu_info(uv_cpu_info_t* cpu_infos, int count);
UV_EXTERN int uv_cpumask_size(void);

UV_EXTERN int uv_interface_addresses(uv_interface_address_t** addresses,
                                     int* count);
UV_EXTERN void uv_free_interface_addresses(uv_interface_address_t* addresses,
                                           int count);

struct uv_env_item_s {
  char* name;
  char* value;
};

UV_EXTERN int uv_os_environ(uv_env_item_t** envitems, int* count);
UV_EXTERN void uv_os_free_environ(uv_env_item_t* envitems, int count);
UV_EXTERN int uv_os_getenv(const char* name, char* buffer, size_t* size);
UV_EXTERN int uv_os_setenv(const char* name, const char* value);
UV_EXTERN int uv_os_unsetenv(const char* name);

#ifdef MAXHOSTNAMELEN
# define UV_MAXHOSTNAMESIZE (MAXHOSTNAMELEN + 1)
#else
  /*
    Fallback for the maximum hostname size, including the null terminator. The
    Windows gethostname() documentation states that 256 bytes will always be
    large enough to hold the null-terminated hostname.
  */
# define UV_MAXHOSTNAMESIZE 256
#endif

UV_EXTERN int uv_os_gethostname(char* buffer, size_t* size);

UV_EXTERN int uv_os_uname(uv_utsname_t* buffer);

struct uv_metrics_s {
  uint64_t loop_count;
  uint64_t events;
  uint64_t events_waiting;
  /* private */
  uint64_t* reserved[13];
};

UV_EXTERN int uv_metrics_info(uv_loop_t* loop, uv_metrics_t* metrics);
UV_EXTERN uint64_t uv_metrics_idle_time(uv_loop_t* loop);

typedef enum {
  UV_FS_UNKNOWN = -1,
  UV_FS_CUSTOM,
  UV_FS_OPEN,
  UV_FS_CLOSE,
  UV_FS_READ,
  UV_FS_WRITE,
  UV_FS_SENDFILE,
  UV_FS_STAT,
  UV_FS_LSTAT,
  UV_FS_FSTAT,
  UV_FS_FTRUNCATE,
  UV_FS_UTIME,
  UV_FS_FUTIME,
  UV_FS_ACCESS,
  UV_FS_CHMOD,
  UV_FS_FCHMOD,
  UV_FS_FSYNC,
  UV_FS_FDATASYNC,
  UV_FS_UNLINK,
  UV_FS_RMDIR,
  UV_FS_MKDIR,
  UV_FS_MKDTEMP,
  UV_FS_RENAME,
  UV_FS_SCANDIR,
  UV_FS_LINK,
  UV_FS_SYMLINK,
  UV_FS_READLINK,
  UV_FS_CHOWN,
  UV_FS_FCHOWN,
  UV_FS_REALPATH,
  UV_FS_COPYFILE,
  UV_FS_LCHOWN,
  UV_FS_OPENDIR,
  UV_FS_READDIR,
  UV_FS_CLOSEDIR,
  UV_FS_STATFS,
  UV_FS_MKSTEMP,
  UV_FS_LUTIME
} uv_fs_type;

struct uv_dir_s {
  uv_dirent_t* dirents;
  size_t nentries;
  void* reserved[4];
  UV_DIR_PRIVATE_FIELDS
};

/* uv_fs_t is a subclass of uv_req_t. */
struct uv_fs_s {
  UV_REQ_FIELDS
  uv_fs_type fs_type;
  uv_loop_t* loop;
  uv_fs_cb cb;
  ssize_t result;
  void* ptr;
  const char* path;
  uv_stat_t statbuf;  /* Stores the result of uv_fs_stat() and uv_fs_fstat(). */
  UV_FS_PRIVATE_FIELDS
};

UV_EXTERN uv_fs_type uv_fs_get_type(const uv_fs_t*);
UV_EXTERN ssize_t uv_fs_get_result(const uv_fs_t*);
UV_EXTERN int uv_fs_get_system_error(const uv_fs_t*);
UV_EXTERN void* uv_fs_get_ptr(const uv_fs_t*);
UV_EXTERN const char* uv_fs_get_path(const uv_fs_t*);
UV_EXTERN uv_stat_t* uv_fs_get_statbuf(uv_fs_t*);

UV_EXTERN void uv_fs_req_cleanup(uv_fs_t* req);
UV_EXTERN int uv_fs_close(uv_loop_t* loop,
                          uv_fs_t* req,
                          uv_file file,
                          uv_fs_cb cb);
UV_EXTERN int uv_fs_open(uv_loop_t* loop,
                         uv_fs_t* req,
                         const char* path,
                         int flags,
                         int mode,
                         uv_fs_cb cb);
UV_EXTERN int uv_fs_read(uv_loop_t* loop,
                         uv_fs_t* req,
                         uv_file file,
                         const uv_buf_t bufs[],
                         unsigned int nbufs,
                         int64_t offset,
                         uv_fs_cb cb);
UV_EXTERN int uv_fs_unlink(uv_loop_t* loop,
                           uv_fs_t* req,
                           const char* path,
                           uv_fs_cb cb);
UV_EXTERN int uv_fs_write(uv_loop_t* loop,
                          uv_fs_t* req,
                          uv_file file,
                          const uv_buf_t bufs[],
                          unsigned int nbufs,
                          int64_t offset,
                          uv_fs_cb cb);
/*
 * This flag can be used with uv_fs_copyfile() to return an error if the
 * destination already exists.
 */
#define UV_FS_COPYFILE_EXCL   0x0001

/*
 * This flag can be used with uv_fs_copyfile() to attempt to create a reflink.
 * If copy-on-write is not supported, a fallback copy mechanism is used.
 */
#define UV_FS_COPYFILE_FICLONE 0x0002

/*
 * This flag can be used with uv_fs_copyfile() to attempt to create a reflink.
 * If copy-on-write is not supported, an error is returned.
 */
#define UV_FS_COPYFILE_FICLONE_FORCE 0x0004

UV_EXTERN int uv_fs_copyfile(uv_loop_t* loop,
                             uv_fs_t* req,
                             const char* path,
                             const char* new_path,
                             int flags,
                             uv_fs_cb cb);
UV_EXTERN int uv_fs_mkdir(uv_loop_t* loop,
                          uv_fs_t* req,
                          const char* path,
                          int mode,
                          uv_fs_cb cb);
UV_EXTERN int uv_fs_mkdtemp(uv_loop_t* loop,
                            uv_fs_t* req,
                            const char* tpl,
                            uv_fs_cb cb);
UV_EXTERN int uv_fs_mkstemp(uv_loop_t* loop,
                            uv_fs_t* req,
                            const char* tpl,
                            uv_fs_cb cb);
UV_EXTERN int uv_fs_rmdir(uv_loop_t* loop,
                          uv_fs_t* req,
                          const char* path,
                          uv_fs_cb cb);
UV_EXTERN int uv_fs_scandir(uv_loop_t* loop,
                            uv_fs_t* req,
                            const char* path,
                            int flags,
                            uv_fs_cb cb);
UV_EXTERN int uv_fs_scandir_next(uv_fs_t* req,
                                 uv_dirent_t* ent);
UV_EXTERN int uv_fs_opendir(uv_loop_t* loop,
                            uv_fs_t* req,
                            const char* path,
                            uv_fs_cb cb);
UV_EXTERN int uv_fs_readdir(uv_loop_t* loop,
                            uv_fs_t* req,
                            uv_dir_t* dir,
                            uv_fs_cb cb);
UV_EXTERN int uv_fs_closedir(uv_loop_t* loop,
                             uv_fs_t* req,
                             uv_dir_t* dir,
                             uv_fs_cb cb);
UV_EXTERN int uv_fs_stat(uv_loop_t* loop,
                         uv_fs_t* req,
                         const char* path,
                         uv_fs_cb cb);
UV_EXTERN int uv_fs_fstat(uv_loop_t* loop,
                          uv_fs_t* req,
                          uv_file file,
                          uv_fs_cb cb);
UV_EXTERN int uv_fs_rename(uv_loop_t* loop,
                           uv_fs_t* req,
                           const char* path,
                           const char* new_path,
                           uv_fs_cb cb);
UV_EXTERN int uv_fs_fsync(uv_loop_t* loop,
                          uv_fs_t* req,
                          uv_file file,
                          uv_fs_cb cb);
UV_EXTERN int uv_fs_fdatasync(uv_loop_t* loop,
                              uv_fs_t* req,
                              uv_file file,
                              uv_fs_cb cb);
UV_EXTERN int uv_fs_ftruncate(uv_loop_t* loop,
                              uv_fs_t* req,
                              uv_file file,
                              int64_t offset,
                              uv_fs_cb cb);
UV_EXTERN int uv_fs_sendfile(uv_loop_t* loop,
                             uv_fs_t* req,
                             uv_file out_fd,
                             uv_file in_fd,
                             int64_t in_offset,
                             size_t length,
                             uv_fs_cb cb);
UV_EXTERN int uv_fs_access(uv_loop_t* loop,
                           uv_fs_t* req,
                           const char* path,
                           int mode,
                           uv_fs_cb cb);
UV_EXTERN int uv_fs_chmod(uv_loop_t* loop,
                          uv_fs_t* req,
                          const char* path,
                          int mode,
                          uv_fs_cb cb);
#define UV_FS_UTIME_NOW  (INFINITY)
#define UV_FS_UTIME_OMIT (NAN)
UV_EXTERN int uv_fs_utime(uv_loop_t* loop,
                          uv_fs_t* req,
                          const char* path,
                          double atime,
                          double mtime,
                          uv_fs_cb cb);
UV_EXTERN int uv_fs_futime(uv_loop_t* loop,
                           uv_fs_t* req,
                           uv_file file,
                           double atime,
                           double mtime,
                           uv_fs_cb cb);
UV_EXTERN int uv_fs_lutime(uv_loop_t* loop,
                           uv_fs_t* req,
                           const char* path,
                           double atime,
                           double mtime,
                           uv_fs_cb cb);
UV_EXTERN int uv_fs_lstat(uv_loop_t* loop,
                          uv_fs_t* req,
                          const char* path,
                          uv_fs_cb cb);
UV_EXTERN int uv_fs_link(uv_loop_t* loop,
                         uv_fs_t* req,
                         const char* path,
                         const char* new_path,
                         uv_fs_cb cb);

/*
 * This flag can be used with uv_fs_symlink() on Windows to specify whether
 * path argument points to a directory.
 */
#define UV_FS_SYMLINK_DIR          0x0001

/*
 * This flag can be used with uv_fs_symlink() on Windows to specify whether
 * the symlink is to be created using junction points.
 */
#define UV_FS_SYMLINK_JUNCTION     0x0002

UV_EXTERN int uv_fs_symlink(uv_loop_t* loop,
                            uv_fs_t* req,
                            const char* path,
                            const char* new_path,
                            int flags,
                            uv_fs_cb cb);
UV_EXTERN int uv_fs_readlink(uv_loop_t* loop,
                             uv_fs_t* req,
                             const char* path,
                             uv_fs_cb cb);
UV_EXTERN int uv_fs_realpath(uv_loop_t* loop,
                             uv_fs_t* req,
                             const char* path,
                             uv_fs_cb cb);
UV_EXTERN int uv_fs_fchmod(uv_loop_t* loop,
                           uv_fs_t* req,
                           uv_file file,
                           int mode,
                           uv_fs_cb cb);
UV_EXTERN int uv_fs_chown(uv_loop_t* loop,
                          uv_fs_t* req,
                          const char* path,
                          uv_uid_t uid,
                          uv_gid_t gid,
                          uv_fs_cb cb);
UV_EXTERN int uv_fs_fchown(uv_loop_t* loop,
                           uv_fs_t* req,
                           uv_file file,
                           uv_uid_t uid,
                           uv_gid_t gid,
                           uv_fs_cb cb);
UV_EXTERN int uv_fs_lchown(uv_loop_t* loop,
                           uv_fs_t* req,
                           const char* path,
                           uv_uid_t uid,
                           uv_gid_t gid,
                           uv_fs_cb cb);
UV_EXTERN int uv_fs_statfs(uv_loop_t* loop,
                           uv_fs_t* req,
                           const char* path,
                           uv_fs_cb cb);


enum uv_fs_event {
  UV_RENAME = 1,
  UV_CHANGE = 2
};


struct uv_fs_event_s {
  UV_HANDLE_FIELDS
  /* private */
  char* path;
  UV_FS_EVENT_PRIVATE_FIELDS
};


/*
 * uv_fs_stat() based polling file watcher.
 */
struct uv_fs_poll_s {
  UV_HANDLE_FIELDS
  /* Private, don't touch. */
  void* poll_ctx;
};

UV_EXTERN int uv_fs_poll_init(uv_loop_t* loop, uv_fs_poll_t* handle);
UV_EXTERN int uv_fs_poll_start(uv_fs_poll_t* handle,
                               uv_fs_poll_cb poll_cb,
                               const char* path,
                               unsigned int interval);
UV_EXTERN int uv_fs_poll_stop(uv_fs_poll_t* handle);
UV_EXTERN int uv_fs_poll_getpath(uv_fs_poll_t* handle,
                                 char* buffer,
                                 size_t* size);


struct uv_signal_s {
  UV_HANDLE_FIELDS
  uv_signal_cb signal_cb;
  int signum;
  UV_SIGNAL_PRIVATE_FIELDS
};

UV_EXTERN int uv_signal_init(uv_loop_t* loop, uv_signal_t* handle);
UV_EXTERN int uv_signal_start(uv_signal_t* handle,
                              uv_signal_cb signal_cb,
                              int signum);
UV_EXTERN int uv_signal_start_oneshot(uv_signal_t* handle,
                                      uv_signal_cb signal_cb,
                                      int signum);
UV_EXTERN int uv_signal_stop(uv_signal_t* handle);

UV_EXTERN void uv_loadavg(double avg[3]);


/*
 * Flags to be passed to uv_fs_event_start().
 */
enum uv_fs_event_flags {
  /*
   * By default, if the fs event watcher is given a directory name, we will
   * watch for all events in that directory. This flags overrides this behavior
   * and makes fs_event report only changes to the directory entry itself. This
   * flag does not affect individual files watched.
   * This flag is currently not implemented yet on any backend.
   */
  UV_FS_EVENT_WATCH_ENTRY = 1,

  /*
   * By default uv_fs_event will try to use a kernel interface such as inotify
   * or kqueue to detect events. This may not work on remote filesystems such
   * as NFS mounts. This flag makes fs_event fall back to calling stat() on a
   * regular interval.
   * This flag is currently not implemented yet on any backend.
   */
  UV_FS_EVENT_STAT = 2,

  /*
   * By default, event watcher, when watching directory, is not registering
   * (is ignoring) changes in it's subdirectories.
   * This flag will override this behaviour on platforms that support it.
   */
  UV_FS_EVENT_RECURSIVE = 4
};


UV_EXTERN int uv_fs_event_init(uv_loop_t* loop, uv_fs_event_t* handle);
UV_EXTERN int uv_fs_event_start(uv_fs_event_t* handle,
                                uv_fs_event_cb cb,
                                const char* path,
                                unsigned int flags);
UV_EXTERN int uv_fs_event_stop(uv_fs_event_t* handle);
UV_EXTERN int uv_fs_event_getpath(uv_fs_event_t* handle,
                                  char* buffer,
                                  size_t* size);

UV_EXTERN int uv_ip4_addr(const char* ip, int port, struct sockaddr_in* addr);
UV_EXTERN int uv_ip6_addr(const char* ip, int port, struct sockaddr_in6* addr);

UV_EXTERN int uv_ip4_name(const struct sockaddr_in* src, char* dst, size_t size);
UV_EXTERN int uv_ip6_name(const struct sockaddr_in6* src, char* dst, size_t size);
UV_EXTERN int uv_ip_name(const struct sockaddr* src, char* dst, size_t size);

UV_EXTERN int uv_inet_ntop(int af, const void* src, char* dst, size_t size);
UV_EXTERN int uv_inet_pton(int af, const char* src, void* dst);


struct uv_random_s {
  UV_REQ_FIELDS
  /* read-only */
  uv_loop_t* loop;
  /* private */
  int status;
  void* buf;
  size_t buflen;
  uv_random_cb cb;
  struct uv__work work_req;
};

UV_EXTERN int uv_random(uv_loop_t* loop,
                        uv_random_t* req,
                        void *buf,
                        size_t buflen,
                        unsigned flags,  /* For future extension; must be 0. */
                        uv_random_cb cb);

#if defined(IF_NAMESIZE)
# define UV_IF_NAMESIZE (IF_NAMESIZE + 1)
#elif defined(IFNAMSIZ)
# define UV_IF_NAMESIZE (IFNAMSIZ + 1)
#else
# define UV_IF_NAMESIZE (16 + 1)
#endif

UV_EXTERN int uv_if_indextoname(unsigned int ifindex,
                                char* buffer,
                                size_t* size);
UV_EXTERN int uv_if_indextoiid(unsigned int ifindex,
                               char* buffer,
                               size_t* size);

UV_EXTERN int uv_exepath(char* buffer, size_t* size);

UV_EXTERN int uv_cwd(char* buffer, size_t* size);

UV_EXTERN int uv_chdir(const char* dir);

UV_EXTERN uint64_t uv_get_free_memory(void);
UV_EXTERN uint64_t uv_get_total_memory(void);
UV_EXTERN uint64_t uv_get_constrained_memory(void);
UV_EXTERN uint64_t uv_get_available_memory(void);

UV_EXTERN int uv_clock_gettime(uv_clock_id clock_id, uv_timespec64_t* ts);
UV_EXTERN uint64_t uv_hrtime(void);
UV_EXTERN void uv_sleep(unsigned int msec);

UV_EXTERN void uv_disable_stdio_inheritance(void);

UV_EXTERN int uv_dlopen(const char* filename, uv_lib_t* lib);
UV_EXTERN void uv_dlclose(uv_lib_t* lib);
UV_EXTERN int uv_dlsym(uv_lib_t* lib, const char* name, void** ptr);
UV_EXTERN const char* uv_dlerror(const uv_lib_t* lib);

UV_EXTERN int uv_mutex_init(uv_mutex_t* handle);
UV_EXTERN int uv_mutex_init_recursive(uv_mutex_t* handle);
UV_EXTERN void uv_mutex_destroy(uv_mutex_t* handle);
UV_EXTERN void uv_mutex_lock(uv_mutex_t* handle);
UV_EXTERN int uv_mutex_trylock(uv_mutex_t* handle);
UV_EXTERN void uv_mutex_unlock(uv_mutex_t* handle);

UV_EXTERN int uv_rwlock_init(uv_rwlock_t* rwlock);
UV_EXTERN void uv_rwlock_destroy(uv_rwlock_t* rwlock);
UV_EXTERN void uv_rwlock_rdlock(uv_rwlock_t* rwlock);
UV_EXTERN int uv_rwlock_tryrdlock(uv_rwlock_t* rwlock);
UV_EXTERN void uv_rwlock_rdunlock(uv_rwlock_t* rwlock);
UV_EXTERN void uv_rwlock_wrlock(uv_rwlock_t* rwlock);
UV_EXTERN int uv_rwlock_trywrlock(uv_rwlock_t* rwlock);
UV_EXTERN void uv_rwlock_wrunlock(uv_rwlock_t* rwlock);

UV_EXTERN int uv_sem_init(uv_sem_t* sem, unsigned int value);
UV_EXTERN void uv_sem_destroy(uv_sem_t* sem);
UV_EXTERN void uv_sem_post(uv_sem_t* sem);
UV_EXTERN void uv_sem_wait(uv_sem_t* sem);
UV_EXTERN int uv_sem_trywait(uv_sem_t* sem);

UV_EXTERN int uv_cond_init(uv_cond_t* cond);
UV_EXTERN void uv_cond_destroy(uv_cond_t* cond);
UV_EXTERN void uv_cond_signal(uv_cond_t* cond);
UV_EXTERN void uv_cond_broadcast(uv_cond_t* cond);

UV_EXTERN int uv_barrier_init(uv_barrier_t* barrier, unsigned int count);
UV_EXTERN void uv_barrier_destroy(uv_barrier_t* barrier);
UV_EXTERN int uv_barrier_wait(uv_barrier_t* barrier);

UV_EXTERN void uv_cond_wait(uv_cond_t* cond, uv_mutex_t* mutex);
UV_EXTERN int uv_cond_timedwait(uv_cond_t* cond,
                                uv_mutex_t* mutex,
                                uint64_t timeout);

UV_EXTERN void uv_once(uv_once_t* guard, void (*callback)(void));

UV_EXTERN int uv_key_create(uv_key_t* key);
UV_EXTERN void uv_key_delete(uv_key_t* key);
UV_EXTERN void* uv_key_get(uv_key_t* key);
UV_EXTERN void uv_key_set(uv_key_t* key, void* value);

UV_EXTERN int uv_gettimeofday(uv_timeval64_t* tv);

typedef void (*uv_thread_cb)(void* arg);

UV_EXTERN int uv_thread_create(uv_thread_t* tid, uv_thread_cb entry, void* arg);
UV_EXTERN int uv_thread_detach(uv_thread_t* tid);

typedef enum {
  UV_THREAD_NO_FLAGS = 0x00,
  UV_THREAD_HAS_STACK_SIZE = 0x01
} uv_thread_create_flags;

struct uv_thread_options_s {
  unsigned int flags;
  size_t stack_size;
  /* More fields may be added at any time. */
};

typedef struct uv_thread_options_s uv_thread_options_t;

UV_EXTERN int uv_thread_create_ex(uv_thread_t* tid,
                                  const uv_thread_options_t* params,
                                  uv_thread_cb entry,
                                  void* arg);
UV_EXTERN int uv_thread_setaffinity(uv_thread_t* tid,
                                    char* cpumask,
                                    char* oldmask,
                                    size_t mask_size);
UV_EXTERN int uv_thread_getaffinity(uv_thread_t* tid,
                                    char* cpumask,
                                    size_t mask_size);
UV_EXTERN int uv_thread_getcpu(void);
UV_EXTERN uv_thread_t uv_thread_self(void);
UV_EXTERN int uv_thread_join(uv_thread_t *tid);
UV_EXTERN int uv_thread_equal(const uv_thread_t* t1, const uv_thread_t* t2);
UV_EXTERN int uv_thread_setname(const char* name);
UV_EXTERN int uv_thread_getname(uv_thread_t* tid, char* name, size_t size);


/* The presence of these unions force similar struct layout. */
#define XX(_, name) uv_ ## name ## _t name;
union uv_any_handle {
  UV_HANDLE_TYPE_MAP(XX)
};

union uv_any_req {
  UV_REQ_TYPE_MAP(XX)
};
#undef XX


struct uv_loop_s {
  /* User data - use this for whatever. */
  void* data;
  /* Loop reference counting. */
  unsigned int active_handles;
  struct uv__queue handle_queue;
  union {
    void* unused;
    unsigned int count;
  } active_reqs;
  /* Internal storage for future extensions. */
  void* internal_fields;
  /* Internal flag to signal loop stop. */
  unsigned int stop_flag;
  UV_LOOP_PRIVATE_FIELDS
};

UV_EXTERN void* uv_loop_get_data(const uv_loop_t*);
UV_EXTERN void uv_loop_set_data(uv_loop_t*, void* data);

/* Unicode utilities needed for dealing with Windows. */
UV_EXTERN size_t uv_utf16_length_as_wtf8(const uint16_t* utf16,
                                         ssize_t utf16_len);
UV_EXTERN int uv_utf16_to_wtf8(const uint16_t* utf16,
                               ssize_t utf16_len,
                               char** wtf8_ptr,
                               size_t* wtf8_len_ptr);
UV_EXTERN ssize_t uv_wtf8_length_as_utf16(const char* wtf8);
UV_EXTERN void uv_wtf8_to_utf16(const char* wtf8,
                                uint16_t* utf16,
                                size_t utf16_len);

/* Don't export the private CPP symbols. */
#undef UV_REQ_TYPE_PRIVATE
#undef UV_REQ_PRIVATE_FIELDS
#undef UV_STREAM_PRIVATE_FIELDS
#undef UV_TCP_PRIVATE_FIELDS
#undef UV_PREPARE_PRIVATE_FIELDS
#undef UV_CHECK_PRIVATE_FIELDS
#undef UV_IDLE_PRIVATE_FIELDS
#undef UV_ASYNC_PRIVATE_FIELDS
#undef UV_TIMER_PRIVATE_FIELDS
#undef UV_GETADDRINFO_PRIVATE_FIELDS
#undef UV_GETNAMEINFO_PRIVATE_FIELDS
#undef UV_WORK_PRIVATE_FIELDS
#undef UV_FS_EVENT_PRIVATE_FIELDS
#undef UV_SIGNAL_PRIVATE_FIELDS
#undef UV_LOOP_PRIVATE_FIELDS
#undef UV__ERR

#ifdef __cplusplus
}
#endif
#endif /* UV_H */
