#ifndef __UVWASI_WASI_TYPES_H__
#define __UVWASI_WASI_TYPES_H__

#include <stddef.h>
#include <stdint.h>

/* API: https://github.com/WebAssembly/WASI/blob/main/phases/snapshot/docs.md */

typedef uint32_t uvwasi_size_t;

typedef uint8_t uvwasi_advice_t;
#define UVWASI_ADVICE_NORMAL     0
#define UVWASI_ADVICE_SEQUENTIAL 1
#define UVWASI_ADVICE_RANDOM     2
#define UVWASI_ADVICE_WILLNEED   3
#define UVWASI_ADVICE_DONTNEED   4
#define UVWASI_ADVICE_NOREUSE    5

typedef struct uvwasi_ciovec_s {
  const void* buf;
  uvwasi_size_t buf_len;
} uvwasi_ciovec_t;

typedef uint32_t uvwasi_clockid_t;
#define UVWASI_CLOCK_REALTIME           0
#define UVWASI_CLOCK_MONOTONIC          1
#define UVWASI_CLOCK_PROCESS_CPUTIME_ID 2
#define UVWASI_CLOCK_THREAD_CPUTIME_ID  3

typedef uint64_t uvwasi_device_t;

typedef uint64_t uvwasi_dircookie_t;
#define UVWASI_DIRCOOKIE_START 0

typedef uint16_t uvwasi_errno_t;
#define UVWASI_ESUCCESS         0
#define UVWASI_E2BIG            1
#define UVWASI_EACCES           2
#define UVWASI_EADDRINUSE       3
#define UVWASI_EADDRNOTAVAIL    4
#define UVWASI_EAFNOSUPPORT     5
#define UVWASI_EAGAIN           6
#define UVWASI_EALREADY         7
#define UVWASI_EBADF            8
#define UVWASI_EBADMSG          9
#define UVWASI_EBUSY           10
#define UVWASI_ECANCELED       11
#define UVWASI_ECHILD          12
#define UVWASI_ECONNABORTED    13
#define UVWASI_ECONNREFUSED    14
#define UVWASI_ECONNRESET      15
#define UVWASI_EDEADLK         16
#define UVWASI_EDESTADDRREQ    17
#define UVWASI_EDOM            18
#define UVWASI_EDQUOT          19
#define UVWASI_EEXIST          20
#define UVWASI_EFAULT          21
#define UVWASI_EFBIG           22
#define UVWASI_EHOSTUNREACH    23
#define UVWASI_EIDRM           24
#define UVWASI_EILSEQ          25
#define UVWASI_EINPROGRESS     26
#define UVWASI_EINTR           27
#define UVWASI_EINVAL          28
#define UVWASI_EIO             29
#define UVWASI_EISCONN         30
#define UVWASI_EISDIR          31
#define UVWASI_ELOOP           32
#define UVWASI_EMFILE          33
#define UVWASI_EMLINK          34
#define UVWASI_EMSGSIZE        35
#define UVWASI_EMULTIHOP       36
#define UVWASI_ENAMETOOLONG    37
#define UVWASI_ENETDOWN        38
#define UVWASI_ENETRESET       39
#define UVWASI_ENETUNREACH     40
#define UVWASI_ENFILE          41
#define UVWASI_ENOBUFS         42
#define UVWASI_ENODEV          43
#define UVWASI_ENOENT          44
#define UVWASI_ENOEXEC         45
#define UVWASI_ENOLCK          46
#define UVWASI_ENOLINK         47
#define UVWASI_ENOMEM          48
#define UVWASI_ENOMSG          49
#define UVWASI_ENOPROTOOPT     50
#define UVWASI_ENOSPC          51
#define UVWASI_ENOSYS          52
#define UVWASI_ENOTCONN        53
#define UVWASI_ENOTDIR         54
#define UVWASI_ENOTEMPTY       55
#define UVWASI_ENOTRECOVERABLE 56
#define UVWASI_ENOTSOCK        57
#define UVWASI_ENOTSUP         58
#define UVWASI_ENOTTY          59
#define UVWASI_ENXIO           60
#define UVWASI_EOVERFLOW       61
#define UVWASI_EOWNERDEAD      62
#define UVWASI_EPERM           63
#define UVWASI_EPIPE           64
#define UVWASI_EPROTO          65
#define UVWASI_EPROTONOSUPPORT 66
#define UVWASI_EPROTOTYPE      67
#define UVWASI_ERANGE          68
#define UVWASI_EROFS           69
#define UVWASI_ESPIPE          70
#define UVWASI_ESRCH           71
#define UVWASI_ESTALE          72
#define UVWASI_ETIMEDOUT       73
#define UVWASI_ETXTBSY         74
#define UVWASI_EXDEV           75
#define UVWASI_ENOTCAPABLE     76

typedef uint16_t uvwasi_eventrwflags_t;          /* Bitfield */
#define UVWASI_EVENT_FD_READWRITE_HANGUP (1 << 0)

typedef uint8_t uvwasi_eventtype_t;
#define UVWASI_EVENTTYPE_CLOCK    0
#define UVWASI_EVENTTYPE_FD_READ  1
#define UVWASI_EVENTTYPE_FD_WRITE 2

typedef uint32_t uvwasi_exitcode_t;

typedef uint32_t uvwasi_fd_t;

typedef uint16_t uvwasi_fdflags_t;               /* Bitfield */
#define UVWASI_FDFLAG_APPEND   (1 << 0)
#define UVWASI_FDFLAG_DSYNC    (1 << 1)
#define UVWASI_FDFLAG_NONBLOCK (1 << 2)
#define UVWASI_FDFLAG_RSYNC    (1 << 3)
#define UVWASI_FDFLAG_SYNC     (1 << 4)

typedef int64_t uvwasi_filedelta_t;

typedef uint64_t uvwasi_filesize_t;

typedef uint8_t uvwasi_filetype_t;
#define UVWASI_FILETYPE_UNKNOWN          0
#define UVWASI_FILETYPE_BLOCK_DEVICE     1
#define UVWASI_FILETYPE_CHARACTER_DEVICE 2
#define UVWASI_FILETYPE_DIRECTORY        3
#define UVWASI_FILETYPE_REGULAR_FILE     4
#define UVWASI_FILETYPE_SOCKET_DGRAM     5
#define UVWASI_FILETYPE_SOCKET_STREAM    6
#define UVWASI_FILETYPE_SYMBOLIC_LINK    7

typedef uint16_t uvwasi_fstflags_t;              /* Bitfield */
#define UVWASI_FILESTAT_SET_ATIM      (1 << 0)
#define UVWASI_FILESTAT_SET_ATIM_NOW  (1 << 1)
#define UVWASI_FILESTAT_SET_MTIM      (1 << 2)
#define UVWASI_FILESTAT_SET_MTIM_NOW  (1 << 3)

typedef uint64_t uvwasi_inode_t;

typedef struct uvwasi_iovec_s {
  void* buf;
  uvwasi_size_t buf_len;
} uvwasi_iovec_t;

typedef uint64_t uvwasi_linkcount_t;

typedef uint32_t uvwasi_lookupflags_t;           /* Bitfield */
#define UVWASI_LOOKUP_SYMLINK_FOLLOW (1 << 0)

typedef uint16_t uvwasi_oflags_t;                /* Bitfield */
#define UVWASI_O_CREAT     (1 << 0)
#define UVWASI_O_DIRECTORY (1 << 1)
#define UVWASI_O_EXCL      (1 << 2)
#define UVWASI_O_TRUNC     (1 << 3)

typedef uint8_t uvwasi_preopentype_t;
#define UVWASI_PREOPENTYPE_DIR 0

typedef struct uvwasi_prestat_s {
  uvwasi_preopentype_t pr_type;
  union uvwasi_prestat_u {
    struct uvwasi_prestat_dir_t {
      uvwasi_size_t pr_name_len;
    } dir;
  } u;
} uvwasi_prestat_t;

typedef uint16_t uvwasi_riflags_t;               /* Bitfield */
#define UVWASI_SOCK_RECV_PEEK    (1 << 0)
#define UVWASI_SOCK_RECV_WAITALL (1 << 1)

typedef uint64_t uvwasi_rights_t;                /* Bitfield */
#define UVWASI_RIGHT_FD_DATASYNC             (1 << 0)
#define UVWASI_RIGHT_FD_READ                 (1 << 1)
#define UVWASI_RIGHT_FD_SEEK                 (1 << 2)
#define UVWASI_RIGHT_FD_FDSTAT_SET_FLAGS     (1 << 3)
#define UVWASI_RIGHT_FD_SYNC                 (1 << 4)
#define UVWASI_RIGHT_FD_TELL                 (1 << 5)
#define UVWASI_RIGHT_FD_WRITE                (1 << 6)
#define UVWASI_RIGHT_FD_ADVISE               (1 << 7)
#define UVWASI_RIGHT_FD_ALLOCATE             (1 << 8)
#define UVWASI_RIGHT_PATH_CREATE_DIRECTORY   (1 << 9)
#define UVWASI_RIGHT_PATH_CREATE_FILE        (1 << 10)
#define UVWASI_RIGHT_PATH_LINK_SOURCE        (1 << 11)
#define UVWASI_RIGHT_PATH_LINK_TARGET        (1 << 12)
#define UVWASI_RIGHT_PATH_OPEN               (1 << 13)
#define UVWASI_RIGHT_FD_READDIR              (1 << 14)
#define UVWASI_RIGHT_PATH_READLINK           (1 << 15)
#define UVWASI_RIGHT_PATH_RENAME_SOURCE      (1 << 16)
#define UVWASI_RIGHT_PATH_RENAME_TARGET      (1 << 17)
#define UVWASI_RIGHT_PATH_FILESTAT_GET       (1 << 18)
#define UVWASI_RIGHT_PATH_FILESTAT_SET_SIZE  (1 << 19)
#define UVWASI_RIGHT_PATH_FILESTAT_SET_TIMES (1 << 20)
#define UVWASI_RIGHT_FD_FILESTAT_GET         (1 << 21)
#define UVWASI_RIGHT_FD_FILESTAT_SET_SIZE    (1 << 22)
#define UVWASI_RIGHT_FD_FILESTAT_SET_TIMES   (1 << 23)
#define UVWASI_RIGHT_PATH_SYMLINK            (1 << 24)
#define UVWASI_RIGHT_PATH_REMOVE_DIRECTORY   (1 << 25)
#define UVWASI_RIGHT_PATH_UNLINK_FILE        (1 << 26)
#define UVWASI_RIGHT_POLL_FD_READWRITE       (1 << 27)
#define UVWASI_RIGHT_SOCK_SHUTDOWN           (1 << 28)
#define UVWASI_RIGHT_SOCK_ACCEPT             (1 << 29)

typedef uint16_t uvwasi_roflags_t;               /* Bitfield */
#define UVWASI_SOCK_RECV_DATA_TRUNCATED (1 << 0)

typedef uint8_t uvwasi_sdflags_t;                /* Bitfield */
#define UVWASI_SHUT_RD (1 << 0)
#define UVWASI_SHUT_WR (1 << 1)

typedef uint16_t uvwasi_siflags_t;               /* Bitfield */

typedef uint8_t uvwasi_signal_t;
#define UVWASI_SIGHUP     1
#define UVWASI_SIGINT     2
#define UVWASI_SIGQUIT    3
#define UVWASI_SIGILL     4
#define UVWASI_SIGTRAP    5
#define UVWASI_SIGABRT    6
#define UVWASI_SIGBUS     7
#define UVWASI_SIGFPE     8
#define UVWASI_SIGKILL    9
#define UVWASI_SIGUSR1   10
#define UVWASI_SIGSEGV   11
#define UVWASI_SIGUSR2   12
#define UVWASI_SIGPIPE   13
#define UVWASI_SIGALRM   14
#define UVWASI_SIGTERM   15
#define UVWASI_SIGCHLD   16
#define UVWASI_SIGCONT   17
#define UVWASI_SIGSTOP   18
#define UVWASI_SIGTSTP   19
#define UVWASI_SIGTTIN   20
#define UVWASI_SIGTTOU   21
#define UVWASI_SIGURG    22
#define UVWASI_SIGXCPU   23
#define UVWASI_SIGXFSZ   24
#define UVWASI_SIGVTALRM 25
#define UVWASI_SIGPROF   26
#define UVWASI_SIGWINCH  27
#define UVWASI_SIGPOLL   28
#define UVWASI_SIGPWR    29
#define UVWASI_SIGSYS    30

typedef uint16_t uvwasi_subclockflags_t;         /* Bitfield */
#define UVWASI_SUBSCRIPTION_CLOCK_ABSTIME (1 << 0)

typedef uint64_t uvwasi_timestamp_t;

typedef uint64_t uvwasi_userdata_t;

typedef struct uvwasi_subscription_s {
  uvwasi_userdata_t userdata;
  uvwasi_eventtype_t type;
  union {
    struct {
      uvwasi_clockid_t clock_id;
      uvwasi_timestamp_t timeout;
      uvwasi_timestamp_t precision;
      uvwasi_subclockflags_t flags;
    } clock;
    struct {
      uvwasi_fd_t fd;
    } fd_readwrite;
  } u;
} uvwasi_subscription_t;

typedef struct uvwasi_dirent_s {
  uvwasi_dircookie_t d_next;
  uvwasi_inode_t d_ino;
  uint32_t d_namlen;
  uvwasi_filetype_t d_type;
} uvwasi_dirent_t;

typedef struct uvwasi_fdstat_s {
  uvwasi_filetype_t fs_filetype;
  uvwasi_fdflags_t fs_flags;
  uvwasi_rights_t fs_rights_base;
  uvwasi_rights_t fs_rights_inheriting;
} uvwasi_fdstat_t;

typedef struct uvwasi_filestat_s {
  uvwasi_device_t st_dev;
  uvwasi_inode_t st_ino;
  uvwasi_filetype_t st_filetype;
  uvwasi_linkcount_t st_nlink;
  uvwasi_filesize_t st_size;
  uvwasi_timestamp_t st_atim;
  uvwasi_timestamp_t st_mtim;
  uvwasi_timestamp_t st_ctim;
} uvwasi_filestat_t;

typedef struct uvwasi_event_s {
  uvwasi_userdata_t userdata;
  uvwasi_errno_t error;
  uvwasi_eventtype_t type;
  union {
    struct {
      uvwasi_filesize_t nbytes;
      uvwasi_eventrwflags_t flags;
    } fd_readwrite;
  } u;
} uvwasi_event_t;

typedef uint8_t uvwasi_whence_t;
#define UVWASI_WHENCE_SET 0
#define UVWASI_WHENCE_CUR 1
#define UVWASI_WHENCE_END 2

#ifdef NEED_UVWASI_EXPORT
  #define UVWASI_EXPORT __attribute__((visibility("default")))
#else
  #define UVWASI_EXPORT
#endif /* NEED_UVWASI_EXPORT */

#endif /* __UVWASI_WASI_TYPES_H__ */
