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

#ifndef _WIN32_WINNT
# define _WIN32_WINNT   0x0A00
#endif

#if !defined(_SSIZE_T_) && !defined(_SSIZE_T_DEFINED)
typedef intptr_t ssize_t;
# define SSIZE_MAX INTPTR_MAX
# define _SSIZE_T_
# define _SSIZE_T_DEFINED
#endif

#include <winsock2.h>

#ifndef LOCALE_INVARIANT
# define LOCALE_INVARIANT 0x007f
#endif

#include <mswsock.h>
/* Disable the typedef in mstcpip.h of MinGW. */
#define _TCP_INITIAL_RTO_PARAMETERS _TCP_INITIAL_RTO_PARAMETERS__AVOID
#define TCP_INITIAL_RTO_PARAMETERS TCP_INITIAL_RTO_PARAMETERS__AVOID
#define PTCP_INITIAL_RTO_PARAMETERS PTCP_INITIAL_RTO_PARAMETERS__AVOID
#include <ws2tcpip.h>
#undef _TCP_INITIAL_RTO_PARAMETERS
#undef TCP_INITIAL_RTO_PARAMETERS
#undef PTCP_INITIAL_RTO_PARAMETERS
#include <windows.h>

#include <process.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <stdint.h>

#include "uv/tree.h"
#include "uv/threadpool.h"

#define MAX_PIPENAME_LEN 256

#ifndef S_IFLNK
# define S_IFLNK 0xA000
#endif

/* Define missing in Windows Kit Include\{VERSION}\ucrt\sys\stat.h */
#if defined(_CRT_INTERNAL_NONSTDC_NAMES) && _CRT_INTERNAL_NONSTDC_NAMES && !defined(S_IFIFO)
# define S_IFIFO _S_IFIFO
#endif

/* Additional signals supported by uv_signal and or uv_kill. The CRT defines
 * the following signals already:
 *
 *   #define SIGINT           2
 *   #define SIGILL           4
 *   #define SIGABRT_COMPAT   6
 *   #define SIGFPE           8
 *   #define SIGSEGV         11
 *   #define SIGTERM         15
 *   #define SIGBREAK        21
 *   #define SIGABRT         22
 *
 * The additional signals have values that are common on other Unix
 * variants (Linux and Darwin)
 */
#define SIGHUP                1
#define SIGQUIT               3
#define SIGKILL               9
#define SIGWINCH             28

/* Redefine NSIG to take SIGWINCH into consideration */
#if defined(NSIG) && NSIG <= SIGWINCH
# undef NSIG
#endif
#ifndef NSIG
# define NSIG SIGWINCH + 1
#endif

/* The CRT defines SIGABRT_COMPAT as 6, which equals SIGABRT on many unix-like
 * platforms. However MinGW doesn't define it, so we do. */
#ifndef SIGABRT_COMPAT
# define SIGABRT_COMPAT       6
#endif

/*
 * Guids and typedefs for winsock extension functions
 * Mingw32 doesn't have these :-(
 */
#ifndef WSAID_ACCEPTEX
# define WSAID_ACCEPTEX                                                       \
         {0xb5367df1, 0xcbac, 0x11cf,                                         \
         {0x95, 0xca, 0x00, 0x80, 0x5f, 0x48, 0xa1, 0x92}}

# define WSAID_CONNECTEX                                                      \
         {0x25a207b9, 0xddf3, 0x4660,                                         \
         {0x8e, 0xe9, 0x76, 0xe5, 0x8c, 0x74, 0x06, 0x3e}}

# define WSAID_GETACCEPTEXSOCKADDRS                                           \
         {0xb5367df2, 0xcbac, 0x11cf,                                         \
         {0x95, 0xca, 0x00, 0x80, 0x5f, 0x48, 0xa1, 0x92}}

# define WSAID_DISCONNECTEX                                                   \
         {0x7fda2e11, 0x8630, 0x436f,                                         \
         {0xa0, 0x31, 0xf5, 0x36, 0xa6, 0xee, 0xc1, 0x57}}

# define WSAID_TRANSMITFILE                                                   \
         {0xb5367df0, 0xcbac, 0x11cf,                                         \
         {0x95, 0xca, 0x00, 0x80, 0x5f, 0x48, 0xa1, 0x92}}

  typedef BOOL (PASCAL *LPFN_ACCEPTEX)
                      (SOCKET sListenSocket,
                       SOCKET sAcceptSocket,
                       PVOID lpOutputBuffer,
                       DWORD dwReceiveDataLength,
                       DWORD dwLocalAddressLength,
                       DWORD dwRemoteAddressLength,
                       LPDWORD lpdwBytesReceived,
                       LPOVERLAPPED lpOverlapped);

  typedef BOOL (PASCAL *LPFN_CONNECTEX)
                      (SOCKET s,
                       const struct sockaddr* name,
                       int namelen,
                       PVOID lpSendBuffer,
                       DWORD dwSendDataLength,
                       LPDWORD lpdwBytesSent,
                       LPOVERLAPPED lpOverlapped);

  typedef void (PASCAL *LPFN_GETACCEPTEXSOCKADDRS)
                      (PVOID lpOutputBuffer,
                       DWORD dwReceiveDataLength,
                       DWORD dwLocalAddressLength,
                       DWORD dwRemoteAddressLength,
                       LPSOCKADDR* LocalSockaddr,
                       LPINT LocalSockaddrLength,
                       LPSOCKADDR* RemoteSockaddr,
                       LPINT RemoteSockaddrLength);

  typedef BOOL (PASCAL *LPFN_DISCONNECTEX)
                      (SOCKET hSocket,
                       LPOVERLAPPED lpOverlapped,
                       DWORD dwFlags,
                       DWORD reserved);

  typedef BOOL (PASCAL *LPFN_TRANSMITFILE)
                      (SOCKET hSocket,
                       HANDLE hFile,
                       DWORD nNumberOfBytesToWrite,
                       DWORD nNumberOfBytesPerSend,
                       LPOVERLAPPED lpOverlapped,
                       LPTRANSMIT_FILE_BUFFERS lpTransmitBuffers,
                       DWORD dwFlags);

  typedef PVOID RTL_SRWLOCK;
  typedef RTL_SRWLOCK SRWLOCK, *PSRWLOCK;
#endif

typedef int (WSAAPI* LPFN_WSARECV)
            (SOCKET socket,
             LPWSABUF buffers,
             DWORD buffer_count,
             LPDWORD bytes,
             LPDWORD flags,
             LPWSAOVERLAPPED overlapped,
             LPWSAOVERLAPPED_COMPLETION_ROUTINE completion_routine);

typedef int (WSAAPI* LPFN_WSARECVFROM)
            (SOCKET socket,
             LPWSABUF buffers,
             DWORD buffer_count,
             LPDWORD bytes,
             LPDWORD flags,
             struct sockaddr* addr,
             LPINT addr_len,
             LPWSAOVERLAPPED overlapped,
             LPWSAOVERLAPPED_COMPLETION_ROUTINE completion_routine);

#ifndef _NTDEF_
  typedef LONG NTSTATUS;
  typedef NTSTATUS *PNTSTATUS;
#endif

#ifndef RTL_CONDITION_VARIABLE_INIT
  typedef PVOID CONDITION_VARIABLE, *PCONDITION_VARIABLE;
#endif

typedef struct _AFD_POLL_HANDLE_INFO {
  HANDLE Handle;
  ULONG Events;
  NTSTATUS Status;
} AFD_POLL_HANDLE_INFO, *PAFD_POLL_HANDLE_INFO;

typedef struct _AFD_POLL_INFO {
  LARGE_INTEGER Timeout;
  ULONG NumberOfHandles;
  ULONG Exclusive;
  AFD_POLL_HANDLE_INFO Handles[1];
} AFD_POLL_INFO, *PAFD_POLL_INFO;

#define UV_MSAFD_PROVIDER_COUNT 4


/**
 * It should be possible to cast uv_buf_t[] to WSABUF[]
 * see http://msdn.microsoft.com/en-us/library/ms741542(v=vs.85).aspx
 */
typedef struct uv_buf_t {
  ULONG len;
  char* base;
} uv_buf_t;

typedef int uv_file;
typedef SOCKET uv_os_sock_t;
typedef HANDLE uv_os_fd_t;
typedef int uv_pid_t;

typedef HANDLE uv_thread_t;

typedef HANDLE uv_sem_t;

typedef CRITICAL_SECTION uv_mutex_t;

/* This condition variable implementation is based on the SetEvent solution
 * (section 3.2) at http://www.cs.wustl.edu/~schmidt/win32-cv-1.html
 * We could not use the SignalObjectAndWait solution (section 3.4) because
 * it want the 2nd argument (type uv_mutex_t) of uv_cond_wait() and
 * uv_cond_timedwait() to be HANDLEs, but we use CRITICAL_SECTIONs.
 */

typedef union {
  CONDITION_VARIABLE cond_var;
  struct {
    unsigned int waiters_count;
    CRITICAL_SECTION waiters_count_lock;
    HANDLE signal_event;
    HANDLE broadcast_event;
  } unused_; /* TODO: retained for ABI compatibility; remove me in v2.x. */
} uv_cond_t;

typedef struct {
  SRWLOCK read_write_lock_;
  /* TODO: retained for ABI compatibility; remove me in v2.x */
#ifdef _WIN64
  unsigned char padding_[72];
#else
  unsigned char padding_[44];
#endif
} uv_rwlock_t;

typedef struct {
  unsigned threshold;
  unsigned in;
  uv_mutex_t mutex;
  /* TODO: in v2 make this a uv_cond_t, without unused_ */
  CONDITION_VARIABLE cond;
  unsigned out;
} uv_barrier_t;

typedef struct {
  DWORD tls_index;
} uv_key_t;

#define UV_ONCE_INIT { 0, { NULL } }

typedef struct uv_once_s {
  unsigned char unused;
  INIT_ONCE init_once;
} uv_once_t;

/* Platform-specific definitions for uv_spawn support. */
typedef unsigned char uv_uid_t;
typedef unsigned char uv_gid_t;

typedef struct uv__dirent_s {
  int d_type;
  char d_name[1];
} uv__dirent_t;

#define UV_DIR_PRIVATE_FIELDS \
  HANDLE dir_handle;          \
  WIN32_FIND_DATAW find_data; \
  BOOL need_find_call;

#define HAVE_DIRENT_TYPES
#define UV__DT_DIR     UV_DIRENT_DIR
#define UV__DT_FILE    UV_DIRENT_FILE
#define UV__DT_LINK    UV_DIRENT_LINK
#define UV__DT_FIFO    UV_DIRENT_FIFO
#define UV__DT_SOCKET  UV_DIRENT_SOCKET
#define UV__DT_CHAR    UV_DIRENT_CHAR
#define UV__DT_BLOCK   UV_DIRENT_BLOCK

/* Platform-specific definitions for uv_dlopen support. */
#define UV_DYNAMIC FAR WINAPI
typedef struct {
  HMODULE handle;
  char* errmsg;
} uv_lib_t;

#define UV_LOOP_PRIVATE_FIELDS                                                \
    /* The loop's I/O completion port */                                      \
  HANDLE iocp;                                                                \
  /* The current time according to the event loop. in msecs. */               \
  uint64_t time;                                                              \
  /* Tail of a single-linked circular queue of pending reqs. If the queue */  \
  /* is empty, tail_ is NULL. If there is only one item, */                   \
  /* tail_->next_req == tail_ */                                              \
  uv_req_t* pending_reqs_tail;                                                \
  /* Head of a single-linked list of closed handles */                        \
  uv_handle_t* endgame_handles;                                               \
  /* TODO(bnoordhuis) Stop heap-allocating |timer_heap| in libuv v2.x. */     \
  void* timer_heap;                                                           \
    /* Lists of active loop (prepare / check / idle) watchers */              \
  uv_prepare_t* prepare_handles;                                              \
  uv_check_t* check_handles;                                                  \
  uv_idle_t* idle_handles;                                                    \
  /* This pointer will refer to the prepare/check/idle handle whose */        \
  /* callback is scheduled to be called next. This is needed to allow */      \
  /* safe removal from one of the lists above while that list being */        \
  /* iterated over. */                                                        \
  uv_prepare_t* next_prepare_handle;                                          \
  uv_check_t* next_check_handle;                                              \
  uv_idle_t* next_idle_handle;                                                \
  /* This handle holds the peer sockets for the fast variant of uv_poll_t */  \
  SOCKET poll_peer_sockets[UV_MSAFD_PROVIDER_COUNT];                          \
  /* No longer used. */                                                       \
  unsigned int active_tcp_streams;                                            \
  /* No longer used. */                                                       \
  unsigned int active_udp_streams;                                            \
  /* Counter to started timer */                                              \
  uint64_t timer_counter;                                                     \
  /* Threadpool */                                                            \
  struct uv__queue wq;                                                        \
  uv_mutex_t wq_mutex;                                                        \
  uv_async_t wq_async;

#define UV_REQ_TYPE_PRIVATE                                                   \
  /* TODO: remove the req suffix */                                           \
  UV_ACCEPT,                                                                  \
  UV_FS_EVENT_REQ,                                                            \
  UV_POLL_REQ,                                                                \
  UV_PROCESS_EXIT,                                                            \
  UV_READ,                                                                    \
  UV_UDP_RECV,                                                                \
  UV_WAKEUP,                                                                  \
  UV_SIGNAL_REQ,

#define UV_REQ_PRIVATE_FIELDS                                                 \
  union {                                                                     \
    /* Used by I/O operations */                                              \
    struct {                                                                  \
      OVERLAPPED overlapped;                                                  \
      size_t queued_bytes;                                                    \
    } io;                                                                     \
    /* in v2, we can move these to the UV_CONNECT_PRIVATE_FIELDS */           \
    struct {                                                                  \
      ULONG_PTR result; /* overlapped.Internal is reused to hold the result */\
      HANDLE pipeHandle;                                                      \
      DWORD duplex_flags;                                                     \
      WCHAR* name;                                                             \
    } connect;                                                                \
  } u;                                                                        \
  struct uv_req_s* next_req;

#define UV_WRITE_PRIVATE_FIELDS \
  int coalesced;                \
  uv_buf_t write_buffer;        \
  HANDLE event_handle;          \
  HANDLE wait_handle;

#define UV_CONNECT_PRIVATE_FIELDS                                             \
  /* empty */

#define UV_SHUTDOWN_PRIVATE_FIELDS                                            \
  /* empty */

#define UV_UDP_SEND_PRIVATE_FIELDS                                            \
  /* empty */

#define UV_PRIVATE_REQ_TYPES                                                  \
  typedef struct uv_pipe_accept_s {                                           \
    UV_REQ_FIELDS                                                             \
    HANDLE pipeHandle;                                                        \
    struct uv_pipe_accept_s* next_pending;                                    \
  } uv_pipe_accept_t;                                                         \
                                                                              \
  typedef struct uv_tcp_accept_s {                                            \
    UV_REQ_FIELDS                                                             \
    SOCKET accept_socket;                                                     \
    char accept_buffer[sizeof(struct sockaddr_storage) * 2 + 32];             \
    HANDLE event_handle;                                                      \
    HANDLE wait_handle;                                                       \
    struct uv_tcp_accept_s* next_pending;                                     \
  } uv_tcp_accept_t;                                                          \
                                                                              \
  typedef struct uv_read_s {                                                  \
    UV_REQ_FIELDS                                                             \
    HANDLE event_handle;                                                      \
    HANDLE wait_handle;                                                       \
  } uv_read_t;

#define uv_stream_connection_fields                                           \
  unsigned int write_reqs_pending;                                            \
  uv_shutdown_t* shutdown_req;

#define uv_stream_server_fields                                               \
  uv_connection_cb connection_cb;

#define UV_STREAM_PRIVATE_FIELDS                                              \
  unsigned int reqs_pending;                                                  \
  int activecnt;                                                              \
  uv_read_t read_req;                                                         \
  union {                                                                     \
    struct { uv_stream_connection_fields } conn;                              \
    struct { uv_stream_server_fields     } serv;                              \
  } stream;

#define uv_tcp_server_fields                                                  \
  uv_tcp_accept_t* accept_reqs;                                               \
  unsigned int processed_accepts;                                             \
  uv_tcp_accept_t* pending_accepts;                                           \
  LPFN_ACCEPTEX func_acceptex;

#define uv_tcp_connection_fields                                              \
  uv_buf_t read_buffer;                                                       \
  LPFN_CONNECTEX func_connectex;

#define UV_TCP_PRIVATE_FIELDS                                                 \
  SOCKET socket;                                                              \
  int delayed_error;                                                          \
  union {                                                                     \
    struct { uv_tcp_server_fields } serv;                                     \
    struct { uv_tcp_connection_fields } conn;                                 \
  } tcp;

#define UV_UDP_PRIVATE_FIELDS                                                 \
  SOCKET socket;                                                              \
  unsigned int reqs_pending;                                                  \
  int activecnt;                                                              \
  uv_req_t recv_req;                                                          \
  uv_buf_t recv_buffer;                                                       \
  struct sockaddr_storage recv_from;                                          \
  int recv_from_len;                                                          \
  uv_udp_recv_cb recv_cb;                                                     \
  uv_alloc_cb alloc_cb;                                                       \
  LPFN_WSARECV func_wsarecv;                                                  \
  LPFN_WSARECVFROM func_wsarecvfrom;

#define uv_pipe_server_fields                                                 \
  int pending_instances;                                                      \
  uv_pipe_accept_t* accept_reqs;                                              \
  uv_pipe_accept_t* pending_accepts;

#define uv_pipe_connection_fields                                             \
  uv_timer_t* eof_timer;                                                      \
  uv_write_t dummy; /* TODO: retained for ABI compat; remove this in v2.x. */ \
  DWORD ipc_remote_pid;                                                       \
  union {                                                                     \
    uint32_t payload_remaining;                                               \
    uint64_t dummy; /* TODO: retained for ABI compat; remove this in v2.x. */ \
  } ipc_data_frame;                                                           \
  struct uv__queue ipc_xfer_queue;                                            \
  int ipc_xfer_queue_length;                                                  \
  uv_write_t* non_overlapped_writes_tail;                                     \
  CRITICAL_SECTION readfile_thread_lock;                                      \
  volatile HANDLE readfile_thread_handle;

#define UV_PIPE_PRIVATE_FIELDS                                                \
  HANDLE handle;                                                              \
  WCHAR* name;                                                                \
  union {                                                                     \
    struct { uv_pipe_server_fields } serv;                                    \
    struct { uv_pipe_connection_fields } conn;                                \
  } pipe;

/* TODO: put the parser states in a union - TTY handles are always half-duplex
 * so read-state can safely overlap write-state. */
#define UV_TTY_PRIVATE_FIELDS                                                 \
  HANDLE handle;                                                              \
  union {                                                                     \
    struct {                                                                  \
      /* Used for readable TTY handles */                                     \
      union {                                                                 \
        /* TODO: remove me in v2.x. */                                        \
        HANDLE unused_;                                                       \
        int mode;                                                             \
      } mode;                                                                 \
      uv_buf_t read_line_buffer;                                              \
      HANDLE read_raw_wait;                                                   \
      /* Fields used for translating win keystrokes into vt100 characters */  \
      char last_key[8];                                                       \
      unsigned char last_key_offset;                                          \
      unsigned char last_key_len;                                             \
      WCHAR last_utf16_high_surrogate;                                        \
      INPUT_RECORD last_input_record;                                         \
    } rd;                                                                     \
    struct {                                                                  \
      /* Used for writable TTY handles */                                     \
      /* utf8-to-utf16 conversion state */                                    \
      unsigned int utf8_codepoint;                                            \
      unsigned char utf8_bytes_left;                                          \
      /* eol conversion state */                                              \
      unsigned char previous_eol;                                             \
      /* ansi parser state */                                                 \
      unsigned short ansi_parser_state;                                       \
      unsigned char ansi_csi_argc;                                            \
      unsigned short ansi_csi_argv[4];                                        \
      COORD saved_position;                                                   \
      WORD saved_attributes;                                                  \
    } wr;                                                                     \
  } tty;

#define UV_POLL_PRIVATE_FIELDS                                                \
  SOCKET socket;                                                              \
  /* Used in fast mode */                                                     \
  SOCKET peer_socket;                                                         \
  AFD_POLL_INFO afd_poll_info_1;                                              \
  AFD_POLL_INFO afd_poll_info_2;                                              \
  /* Used in fast and slow mode. */                                           \
  uv_req_t poll_req_1;                                                        \
  uv_req_t poll_req_2;                                                        \
  unsigned char submitted_events_1;                                           \
  unsigned char submitted_events_2;                                           \
  unsigned char mask_events_1;                                                \
  unsigned char mask_events_2;                                                \
  unsigned char events;

#define UV_TIMER_PRIVATE_FIELDS                                               \
  union {                                                                     \
    void* heap[3];                                                            \
    struct uv__queue queue;                                                   \
  } node;                                                                     \
  int unused;                                                                 \
  uint64_t timeout;                                                           \
  uint64_t repeat;                                                            \
  uint64_t start_id;                                                          \
  uv_timer_cb timer_cb;

#define UV_ASYNC_PRIVATE_FIELDS                                               \
  struct uv_req_s async_req;                                                  \
  uv_async_cb async_cb;                                                       \
  /* char to avoid alignment issues */                                        \
  char volatile async_sent;

#define UV_PREPARE_PRIVATE_FIELDS                                             \
  uv_prepare_t* prepare_prev;                                                 \
  uv_prepare_t* prepare_next;                                                 \
  uv_prepare_cb prepare_cb;

#define UV_CHECK_PRIVATE_FIELDS                                               \
  uv_check_t* check_prev;                                                     \
  uv_check_t* check_next;                                                     \
  uv_check_cb check_cb;

#define UV_IDLE_PRIVATE_FIELDS                                                \
  uv_idle_t* idle_prev;                                                       \
  uv_idle_t* idle_next;                                                       \
  uv_idle_cb idle_cb;

#define UV_HANDLE_PRIVATE_FIELDS                                              \
  uv_handle_t* endgame_next;                                                  \
  unsigned int flags;

#define UV_GETADDRINFO_PRIVATE_FIELDS                                         \
  struct uv__work work_req;                                                   \
  uv_getaddrinfo_cb getaddrinfo_cb;                                           \
  void* alloc;                                                                \
  WCHAR* node;                                                                \
  WCHAR* service;                                                             \
  /* The addrinfoW field is used to store a pointer to the hints, and    */   \
  /* later on to store the result of GetAddrInfoW. The final result will */   \
  /* be converted to struct addrinfo* and stored in the addrinfo field.  */   \
  struct addrinfoW* addrinfow;                                                \
  struct addrinfo* addrinfo;                                                  \
  int retcode;

#define UV_GETNAMEINFO_PRIVATE_FIELDS                                         \
  struct uv__work work_req;                                                   \
  uv_getnameinfo_cb getnameinfo_cb;                                           \
  struct sockaddr_storage storage;                                            \
  int flags;                                                                  \
  char host[NI_MAXHOST];                                                      \
  char service[NI_MAXSERV];                                                   \
  int retcode;

#define UV_PROCESS_PRIVATE_FIELDS                                             \
  struct uv_process_exit_s {                                                  \
    UV_REQ_FIELDS                                                             \
  } exit_req;                                                                 \
  void* unused; /* TODO: retained for ABI compat; remove this in v2.x. */     \
  int exit_signal;                                                            \
  HANDLE wait_handle;                                                         \
  HANDLE process_handle;                                                      \
  volatile char exit_cb_pending;

#define UV_FS_PRIVATE_FIELDS                                                  \
  struct uv__work work_req;                                                   \
  int flags;                                                                  \
  DWORD sys_errno_;                                                           \
  union {                                                                     \
    /* TODO: remove me in 0.9. */                                             \
    WCHAR* pathw;                                                             \
    int fd;                                                                   \
  } file;                                                                     \
  union {                                                                     \
    struct {                                                                  \
      int mode;                                                               \
      WCHAR* new_pathw;                                                       \
      int file_flags;                                                         \
      int fd_out;                                                             \
      unsigned int nbufs;                                                     \
      uv_buf_t* bufs;                                                         \
      int64_t offset;                                                         \
      uv_buf_t bufsml[4];                                                     \
    } info;                                                                   \
    struct {                                                                  \
      double atime;                                                           \
      double mtime;                                                           \
    } time;                                                                   \
  } fs;

#define UV_WORK_PRIVATE_FIELDS                                                \
  struct uv__work work_req;

#define UV_FS_EVENT_PRIVATE_FIELDS                                            \
  struct uv_fs_event_req_s {                                                  \
    UV_REQ_FIELDS                                                             \
  } req;                                                                      \
  HANDLE dir_handle;                                                          \
  int req_pending;                                                            \
  uv_fs_event_cb cb;                                                          \
  WCHAR* filew;                                                               \
  WCHAR* short_filew;                                                         \
  WCHAR* dirw;                                                                \
  char* buffer;

#define UV_SIGNAL_PRIVATE_FIELDS                                              \
  RB_ENTRY(uv_signal_s) tree_entry;                                           \
  struct uv_req_s signal_req;                                                 \
  unsigned long pending_signum;

#ifndef F_OK
#define F_OK 0
#endif
#ifndef R_OK
#define R_OK 4
#endif
#ifndef W_OK
#define W_OK 2
#endif
#ifndef X_OK
#define X_OK 1
#endif

/* fs open() flags supported on this platform: */
#define UV_FS_O_APPEND       _O_APPEND
#define UV_FS_O_CREAT        _O_CREAT
#define UV_FS_O_EXCL         _O_EXCL
#define UV_FS_O_FILEMAP      0x20000000
#define UV_FS_O_RANDOM       _O_RANDOM
#define UV_FS_O_RDONLY       _O_RDONLY
#define UV_FS_O_RDWR         _O_RDWR
#define UV_FS_O_SEQUENTIAL   _O_SEQUENTIAL
#define UV_FS_O_SHORT_LIVED  _O_SHORT_LIVED
#define UV_FS_O_TEMPORARY    _O_TEMPORARY
#define UV_FS_O_TRUNC        _O_TRUNC
#define UV_FS_O_WRONLY       _O_WRONLY

/* fs open() flags supported on other platforms (or mapped on this platform): */
#define UV_FS_O_DIRECT       0x02000000 /* FILE_FLAG_NO_BUFFERING */
#define UV_FS_O_DIRECTORY    0
#define UV_FS_O_DSYNC        0x04000000 /* FILE_FLAG_WRITE_THROUGH */
#define UV_FS_O_EXLOCK       0x10000000 /* EXCLUSIVE SHARING MODE */
#define UV_FS_O_NOATIME      0
#define UV_FS_O_NOCTTY       0
#define UV_FS_O_NOFOLLOW     0
#define UV_FS_O_NONBLOCK     0
#define UV_FS_O_SYMLINK      0
#define UV_FS_O_SYNC         0x08000000 /* FILE_FLAG_WRITE_THROUGH */
