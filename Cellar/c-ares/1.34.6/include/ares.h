/* MIT License
 *
 * Copyright (c) Massachusetts Institute of Technology
 * Copyright (c) Daniel Stenberg
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice (including the next
 * paragraph) shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * SPDX-License-Identifier: MIT
 */

#ifndef ARES__H
#define ARES__H

#include "ares_version.h" /* c-ares version defines   */
#include "ares_build.h"   /* c-ares build definitions */

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#endif

#ifdef CARES_HAVE_SYS_TYPES_H
#  include <sys/types.h>
#endif

#ifdef CARES_HAVE_SYS_SOCKET_H
#  include <sys/socket.h>
#endif

#ifdef CARES_HAVE_SYS_SELECT_H
#  include <sys/select.h>
#endif

#ifdef CARES_HAVE_WINSOCK2_H
#  include <winsock2.h>
/* To aid with linking against a static c-ares build, lets tell the microsoft
 * compiler to pull in needed dependencies */
#  ifdef _MSC_VER
#    pragma comment(lib, "ws2_32")
#    pragma comment(lib, "advapi32")
#    pragma comment(lib, "iphlpapi")
#  endif
#endif

#ifdef CARES_HAVE_WS2TCPIP_H
#  include <ws2tcpip.h>
#endif

#ifdef CARES_HAVE_WINDOWS_H
#  include <windows.h>
#endif

/* HP-UX systems version 9, 10 and 11 lack sys/select.h and so does oldish
   libc5-based Linux systems. Only include it on system that are known to
   require it! */
#if defined(_AIX) || defined(__NOVELL_LIBC__) || defined(__NetBSD__) || \
  defined(__minix) || defined(__SYMBIAN32__) || defined(__INTEGRITY) || \
  defined(ANDROID) || defined(__ANDROID__) || defined(__OpenBSD__) ||   \
  defined(__QNX__) || defined(__MVS__) || defined(__HAIKU__)
#  include <sys/select.h>
#endif

#if (defined(NETWARE) && !defined(__NOVELL_LIBC__))
#  include <sys/bsdskt.h>
#endif

#if !defined(_WIN32)
#  include <netinet/in.h>
#endif

#ifdef WATT32
#  include <tcp.h>
#endif

#if defined(ANDROID) || defined(__ANDROID__)
#  include <jni.h>
#endif

typedef CARES_TYPEOF_ARES_SOCKLEN_T ares_socklen_t;
typedef CARES_TYPEOF_ARES_SSIZE_T   ares_ssize_t;

#ifdef __cplusplus
extern "C" {
#endif

/*
** c-ares external API function linkage decorations.
*/

#if defined(_WIN32) || defined(__CYGWIN__) || defined(__SYMBIAN32__)
#  ifdef CARES_STATICLIB
#    define CARES_EXTERN
#  else
#    ifdef CARES_BUILDING_LIBRARY
#      define CARES_EXTERN __declspec(dllexport)
#    else
#      define CARES_EXTERN __declspec(dllimport)
#    endif
#  endif
#else
#  if defined(__GNUC__) && __GNUC__ >= 4
#    define CARES_EXTERN __attribute__((visibility("default")))
#  elif defined(__INTEL_COMPILER) && __INTEL_COMPILER >= 900
#    define CARES_EXTERN __attribute__((visibility("default")))
#  elif defined(__SUNPRO_C)
#    define CARES_EXTERN _global
#  else
#    define CARES_EXTERN
#  endif
#endif

#ifdef __GNUC__
#  define CARES_GCC_VERSION \
    (__GNUC__ * 10000 + __GNUC_MINOR__ * 100 + __GNUC_PATCHLEVEL__)
#else
#  define CARES_GCC_VERSION 0
#endif

#ifndef __has_attribute
#  define __has_attribute(x) 0
#endif

#ifdef CARES_NO_DEPRECATED
#  define CARES_DEPRECATED
#  define CARES_DEPRECATED_FOR(f)
#else
#  if CARES_GCC_VERSION >= 30200 || __has_attribute(__deprecated__)
#    define CARES_DEPRECATED __attribute__((__deprecated__))
#  else
#    define CARES_DEPRECATED
#  endif

#  if CARES_GCC_VERSION >= 40500 || defined(__clang__)
#    define CARES_DEPRECATED_FOR(f) \
      __attribute__((deprecated("Use " #f " instead")))
#  elif defined(_MSC_VER)
#    define CARES_DEPRECATED_FOR(f) __declspec(deprecated("Use " #f " instead"))
#  else
#    define CARES_DEPRECATED_FOR(f) CARES_DEPRECATED
#  endif
#endif

typedef enum {
  ARES_SUCCESS = 0,

  /* Server error codes (ARES_ENODATA indicates no relevant answer) */
  ARES_ENODATA   = 1,
  ARES_EFORMERR  = 2,
  ARES_ESERVFAIL = 3,
  ARES_ENOTFOUND = 4,
  ARES_ENOTIMP   = 5,
  ARES_EREFUSED  = 6,

  /* Locally generated error codes */
  ARES_EBADQUERY    = 7,
  ARES_EBADNAME     = 8,
  ARES_EBADFAMILY   = 9,
  ARES_EBADRESP     = 10,
  ARES_ECONNREFUSED = 11,
  ARES_ETIMEOUT     = 12,
  ARES_EOF          = 13,
  ARES_EFILE        = 14,
  ARES_ENOMEM       = 15,
  ARES_EDESTRUCTION = 16,
  ARES_EBADSTR      = 17,

  /* ares_getnameinfo error codes */
  ARES_EBADFLAGS = 18,

  /* ares_getaddrinfo error codes */
  ARES_ENONAME   = 19,
  ARES_EBADHINTS = 20,

  /* Uninitialized library error code */
  ARES_ENOTINITIALIZED = 21, /* introduced in 1.7.0 */

  /* ares_library_init error codes */
  ARES_ELOADIPHLPAPI         = 22, /* introduced in 1.7.0 */
  ARES_EADDRGETNETWORKPARAMS = 23, /* introduced in 1.7.0 */

  /* More error codes */
  ARES_ECANCELLED = 24, /* introduced in 1.7.0 */

  /* More ares_getaddrinfo error codes */
  ARES_ESERVICE = 25, /* ares_getaddrinfo() was passed a text service name that
                       * is not recognized. introduced in 1.16.0 */

  ARES_ENOSERVER = 26 /* No DNS servers were configured */
} ares_status_t;

typedef enum {
  ARES_FALSE = 0,
  ARES_TRUE  = 1
} ares_bool_t;

/*! Values for ARES_OPT_EVENT_THREAD */
typedef enum {
  /*! Default (best choice) event system */
  ARES_EVSYS_DEFAULT = 0,
  /*! Win32 IOCP/AFD_POLL event system */
  ARES_EVSYS_WIN32 = 1,
  /*! Linux epoll */
  ARES_EVSYS_EPOLL = 2,
  /*! BSD/MacOS kqueue */
  ARES_EVSYS_KQUEUE = 3,
  /*! POSIX poll() */
  ARES_EVSYS_POLL = 4,
  /*! last fallback on Unix-like systems, select() */
  ARES_EVSYS_SELECT = 5
} ares_evsys_t;

/* Flag values */
#define ARES_FLAG_USEVC       (1 << 0)
#define ARES_FLAG_PRIMARY     (1 << 1)
#define ARES_FLAG_IGNTC       (1 << 2)
#define ARES_FLAG_NORECURSE   (1 << 3)
#define ARES_FLAG_STAYOPEN    (1 << 4)
#define ARES_FLAG_NOSEARCH    (1 << 5)
#define ARES_FLAG_NOALIASES   (1 << 6)
#define ARES_FLAG_NOCHECKRESP (1 << 7)
#define ARES_FLAG_EDNS        (1 << 8)
#define ARES_FLAG_NO_DFLT_SVR (1 << 9)
#define ARES_FLAG_DNS0x20     (1 << 10)

/* Option mask values */
#define ARES_OPT_FLAGS           (1 << 0)
#define ARES_OPT_TIMEOUT         (1 << 1)
#define ARES_OPT_TRIES           (1 << 2)
#define ARES_OPT_NDOTS           (1 << 3)
#define ARES_OPT_UDP_PORT        (1 << 4)
#define ARES_OPT_TCP_PORT        (1 << 5)
#define ARES_OPT_SERVERS         (1 << 6)
#define ARES_OPT_DOMAINS         (1 << 7)
#define ARES_OPT_LOOKUPS         (1 << 8)
#define ARES_OPT_SOCK_STATE_CB   (1 << 9)
#define ARES_OPT_SORTLIST        (1 << 10)
#define ARES_OPT_SOCK_SNDBUF     (1 << 11)
#define ARES_OPT_SOCK_RCVBUF     (1 << 12)
#define ARES_OPT_TIMEOUTMS       (1 << 13)
#define ARES_OPT_ROTATE          (1 << 14)
#define ARES_OPT_EDNSPSZ         (1 << 15)
#define ARES_OPT_NOROTATE        (1 << 16)
#define ARES_OPT_RESOLVCONF      (1 << 17)
#define ARES_OPT_HOSTS_FILE      (1 << 18)
#define ARES_OPT_UDP_MAX_QUERIES (1 << 19)
#define ARES_OPT_MAXTIMEOUTMS    (1 << 20)
#define ARES_OPT_QUERY_CACHE     (1 << 21)
#define ARES_OPT_EVENT_THREAD    (1 << 22)
#define ARES_OPT_SERVER_FAILOVER (1 << 23)

/* Nameinfo flag values */
#define ARES_NI_NOFQDN        (1 << 0)
#define ARES_NI_NUMERICHOST   (1 << 1)
#define ARES_NI_NAMEREQD      (1 << 2)
#define ARES_NI_NUMERICSERV   (1 << 3)
#define ARES_NI_DGRAM         (1 << 4)
#define ARES_NI_TCP           0
#define ARES_NI_UDP           ARES_NI_DGRAM
#define ARES_NI_SCTP          (1 << 5)
#define ARES_NI_DCCP          (1 << 6)
#define ARES_NI_NUMERICSCOPE  (1 << 7)
#define ARES_NI_LOOKUPHOST    (1 << 8)
#define ARES_NI_LOOKUPSERVICE (1 << 9)
/* Reserved for future use */
#define ARES_NI_IDN                      (1 << 10)
#define ARES_NI_IDN_ALLOW_UNASSIGNED     (1 << 11)
#define ARES_NI_IDN_USE_STD3_ASCII_RULES (1 << 12)

/* Addrinfo flag values */
#define ARES_AI_CANONNAME   (1 << 0)
#define ARES_AI_NUMERICHOST (1 << 1)
#define ARES_AI_PASSIVE     (1 << 2)
#define ARES_AI_NUMERICSERV (1 << 3)
#define ARES_AI_V4MAPPED    (1 << 4)
#define ARES_AI_ALL         (1 << 5)
#define ARES_AI_ADDRCONFIG  (1 << 6)
#define ARES_AI_NOSORT      (1 << 7)
#define ARES_AI_ENVHOSTS    (1 << 8)
/* Reserved for future use */
#define ARES_AI_IDN                      (1 << 10)
#define ARES_AI_IDN_ALLOW_UNASSIGNED     (1 << 11)
#define ARES_AI_IDN_USE_STD3_ASCII_RULES (1 << 12)
#define ARES_AI_CANONIDN                 (1 << 13)

#define ARES_AI_MASK                                           \
  (ARES_AI_CANONNAME | ARES_AI_NUMERICHOST | ARES_AI_PASSIVE | \
   ARES_AI_NUMERICSERV | ARES_AI_V4MAPPED | ARES_AI_ALL | ARES_AI_ADDRCONFIG)
#define ARES_GETSOCK_MAXNUM                       \
  16 /* ares_getsock() can return info about this \
        many sockets */
#define ARES_GETSOCK_READABLE(bits, num) (bits & (1 << (num)))
#define ARES_GETSOCK_WRITABLE(bits, num) \
  (bits & (1 << ((num) + ARES_GETSOCK_MAXNUM)))

/* c-ares library initialization flag values */
#define ARES_LIB_INIT_NONE  (0)
#define ARES_LIB_INIT_WIN32 (1 << 0)
#define ARES_LIB_INIT_ALL   (ARES_LIB_INIT_WIN32)

/* Server state callback flag values */
#define ARES_SERV_STATE_UDP (1 << 0) /* Query used UDP */
#define ARES_SERV_STATE_TCP (1 << 1) /* Query used TCP */

/*
 * Typedef our socket type
 */

#ifndef ares_socket_typedef
#  if defined(_WIN32) && !defined(WATT32)
typedef SOCKET ares_socket_t;
#    define ARES_SOCKET_BAD INVALID_SOCKET
#  else
typedef int ares_socket_t;
#    define ARES_SOCKET_BAD -1
#  endif
#  define ares_socket_typedef
#endif /* ares_socket_typedef */

typedef void (*ares_sock_state_cb)(void *data, ares_socket_t socket_fd,
                                   int readable, int writable);

struct apattern;

/* Options controlling server failover behavior.
 * The retry chance is the probability (1/N) by which we will retry a failed
 * server instead of the best server when selecting a server to send queries
 * to.
 * The retry delay is the minimum time in milliseconds to wait between doing
 * such retries (applied per-server).
 */
struct ares_server_failover_options {
  unsigned short retry_chance;
  size_t         retry_delay;
};

/* NOTE about the ares_options struct to users and developers.

   This struct will remain looking like this. It will not be extended nor
   shrunk in future releases, but all new options will be set by ares_set_*()
   options instead of with the ares_init_options() function.

   Eventually (in a galaxy far far away), all options will be settable by
   ares_set_*() options and the ares_init_options() function will become
   deprecated.

   When new options are added to c-ares, they are not added to this
   struct. And they are not "saved" with the ares_save_options() function but
   instead we encourage the use of the ares_dup() function. Needless to say,
   if you add config options to c-ares you need to make sure ares_dup()
   duplicates this new option.

 */
struct ares_options {
  int            flags;
  int            timeout; /* in seconds or milliseconds, depending on options */
  int            tries;
  int            ndots;
  unsigned short udp_port; /* host byte order */
  unsigned short tcp_port; /* host byte order */
  int            socket_send_buffer_size;
  int            socket_receive_buffer_size;
  struct in_addr    *servers;
  int                nservers;
  char             **domains;
  int                ndomains;
  char              *lookups;
  ares_sock_state_cb sock_state_cb;
  void              *sock_state_cb_data;
  struct apattern   *sortlist;
  int                nsort;
  int                ednspsz;
  char              *resolvconf_path;
  char              *hosts_path;
  int                udp_max_queries;
  int                maxtimeout; /* in milliseconds */
  unsigned int qcache_max_ttl;   /* Maximum TTL for query cache, 0=disabled */
  ares_evsys_t evsys;
  struct ares_server_failover_options server_failover_opts;
};

struct hostent;
struct timeval;
struct sockaddr;
struct ares_channeldata;
struct ares_addrinfo;
struct ares_addrinfo_hints;

/* Legacy typedef, don't use, you can't specify "const" */
typedef struct ares_channeldata *ares_channel;

/* Current main channel typedef */
typedef struct ares_channeldata  ares_channel_t;

/*
 * NOTE: before c-ares 1.7.0 we would most often use the system in6_addr
 * struct below when ares itself was built, but many apps would use this
 * private version since the header checked a HAVE_* define for it. Starting
 * with 1.7.0 we always declare and use our own to stop relying on the
 * system's one.
 */
struct ares_in6_addr {
  union {
    unsigned char _S6_u8[16];
  } _S6_un;
};

struct ares_addr {
  int family;

  union {
    struct in_addr       addr4;
    struct ares_in6_addr addr6;
  } addr;
};

/* DNS record parser, writer, and helpers */
#include "ares_dns_record.h"

typedef void (*ares_callback)(void *arg, int status, int timeouts,
                              unsigned char *abuf, int alen);

typedef void (*ares_callback_dnsrec)(void *arg, ares_status_t status,
                                     size_t                   timeouts,
                                     const ares_dns_record_t *dnsrec);

typedef void (*ares_host_callback)(void *arg, int status, int timeouts,
                                   struct hostent *hostent);

typedef void (*ares_nameinfo_callback)(void *arg, int status, int timeouts,
                                       char *node, char *service);

typedef int (*ares_sock_create_callback)(ares_socket_t socket_fd, int type,
                                         void *data);

typedef int (*ares_sock_config_callback)(ares_socket_t socket_fd, int type,
                                         void *data);

typedef void (*ares_addrinfo_callback)(void *arg, int status, int timeouts,
                                       struct ares_addrinfo *res);

typedef void (*ares_server_state_callback)(const char *server_string,
                                           ares_bool_t success, int flags,
                                           void *data);

typedef void (*ares_pending_write_cb)(void *data);

CARES_EXTERN int ares_library_init(int flags);

CARES_EXTERN int ares_library_init_mem(int flags, void *(*amalloc)(size_t size),
                                       void (*afree)(void *ptr),
                                       void *(*arealloc)(void  *ptr,
                                                         size_t size));

#if defined(ANDROID) || defined(__ANDROID__)
CARES_EXTERN void ares_library_init_jvm(JavaVM *jvm);
CARES_EXTERN int  ares_library_init_android(jobject connectivity_manager);
CARES_EXTERN int  ares_library_android_initialized(void);
#endif

#define CARES_HAVE_ARES_LIBRARY_INIT    1
#define CARES_HAVE_ARES_LIBRARY_CLEANUP 1

CARES_EXTERN int         ares_library_initialized(void);

CARES_EXTERN void        ares_library_cleanup(void);

CARES_EXTERN const char *ares_version(int *version);

CARES_EXTERN             CARES_DEPRECATED_FOR(ares_init_options) int ares_init(
  ares_channel_t **channelptr);

CARES_EXTERN int  ares_init_options(ares_channel_t           **channelptr,
                                    const struct ares_options *options,
                                    int                        optmask);

CARES_EXTERN int  ares_save_options(const ares_channel_t *channel,
                                    struct ares_options *options, int *optmask);

CARES_EXTERN void ares_destroy_options(struct ares_options *options);

CARES_EXTERN int  ares_dup(ares_channel_t **dest, const ares_channel_t *src);

CARES_EXTERN ares_status_t ares_reinit(ares_channel_t *channel);

CARES_EXTERN void          ares_destroy(ares_channel_t *channel);

CARES_EXTERN void          ares_cancel(ares_channel_t *channel);

/* These next 3 configure local binding for the out-going socket
 * connection.  Use these to specify source IP and/or network device
 * on multi-homed systems.
 */
CARES_EXTERN void          ares_set_local_ip4(ares_channel_t *channel,
                                              unsigned int    local_ip);

/* local_ip6 should be 16 bytes in length */
CARES_EXTERN void          ares_set_local_ip6(ares_channel_t      *channel,
                                              const unsigned char *local_ip6);

/* local_dev_name should be null terminated. */
CARES_EXTERN void          ares_set_local_dev(ares_channel_t *channel,
                                              const char     *local_dev_name);

CARES_EXTERN void          ares_set_socket_callback(ares_channel_t           *channel,
                                                    ares_sock_create_callback callback,
                                                    void                     *user_data);

CARES_EXTERN void          ares_set_socket_configure_callback(
           ares_channel_t *channel, ares_sock_config_callback callback, void *user_data);

CARES_EXTERN void
                  ares_set_server_state_callback(ares_channel_t            *channel,
                                                 ares_server_state_callback callback,
                                                 void                      *user_data);

CARES_EXTERN void ares_set_pending_write_cb(ares_channel_t       *channel,
                                            ares_pending_write_cb callback,
                                            void                 *user_data);

CARES_EXTERN void ares_process_pending_write(ares_channel_t *channel);

CARES_EXTERN int  ares_set_sortlist(ares_channel_t *channel,
                                    const char     *sortstr);

CARES_EXTERN void ares_getaddrinfo(ares_channel_t *channel, const char *node,
                                   const char                       *service,
                                   const struct ares_addrinfo_hints *hints,
                                   ares_addrinfo_callback callback, void *arg);

CARES_EXTERN void ares_freeaddrinfo(struct ares_addrinfo *ai);

/*
 * Virtual function set to have user-managed socket IO.
 * Note that all functions need to be defined, and when
 * set, the library will not do any bind nor set any
 * socket options, assuming the client handles these
 * through either socket creation or the
 * ares_sock_config_callback call.
 */
struct iovec;

struct ares_socket_functions {
  ares_socket_t (*asocket)(int, int, int, void *);
  int (*aclose)(ares_socket_t, void *);
  int (*aconnect)(ares_socket_t, const struct sockaddr *, ares_socklen_t,
                  void *);
  ares_ssize_t (*arecvfrom)(ares_socket_t, void *, size_t, int,
                            struct sockaddr *, ares_socklen_t *, void *);
  ares_ssize_t (*asendv)(ares_socket_t, const struct iovec *, int, void *);
};

CARES_EXTERN CARES_DEPRECATED_FOR(
  ares_set_socket_functions_ex) void ares_set_socket_functions(ares_channel_t
                                                                 *channel,
                                                               const struct
                                                               ares_socket_functions
                                                                    *funcs,
                                                               void *user_data);

/*! Flags defining behavior of socket functions */
typedef enum {
  /*! Strongly recommended to create sockets as non-blocking and set this
   *  flag */
  ARES_SOCKFUNC_FLAG_NONBLOCKING = 1 << 0
} ares_sockfunc_flags_t;

/*! Socket options in request to asetsockopt() in struct
 *  ares_socket_functions_ex */
typedef enum {
  /*! Set the send buffer size. Value is a pointer to an int. (SO_SNDBUF) */
  ARES_SOCKET_OPT_SENDBUF_SIZE,
  /*! Set the recv buffer size. Value is a pointer to an int. (SO_RCVBUF) */
  ARES_SOCKET_OPT_RECVBUF_SIZE,
  /*! Set the network interface to use as the source for communication.
   *  Value is a C string. (SO_BINDTODEVICE) */
  ARES_SOCKET_OPT_BIND_DEVICE,
  /*! Enable TCP Fast Open.  Value is a pointer to an ares_bool_t.  On some
   *  systems this could be a no-op if it is known it is on by default and
   *  return success.  Other systems may be a no-op if known the system does
   *  not support the feature and returns failure with errno set to ENOSYS or
   *  WSASetLastError(WSAEOPNOTSUPP).
   */
  ARES_SOCKET_OPT_TCP_FASTOPEN
} ares_socket_opt_t;

/*! Flags for behavior during connect */
typedef enum {
  /*! Connect using TCP Fast Open */
  ARES_SOCKET_CONN_TCP_FASTOPEN = 1 << 0
} ares_socket_connect_flags_t;

/*! Flags for behavior during bind */
typedef enum {
  /*! Bind is for a TCP connection */
  ARES_SOCKET_BIND_TCP = 1 << 0,
  /*! Bind is for a client connection, not server */
  ARES_SOCKET_BIND_CLIENT = 1 << 1
} ares_socket_bind_flags_t;

/*! Socket functions to call rather than using OS-native functions */
struct ares_socket_functions_ex {
  /*! ABI Version: must be "1" */
  unsigned int version;

  /*! Flags indicating behavior of the subsystem. One or more
   * ares_sockfunc_flags_t  */
  unsigned int flags;

  /*! REQUIRED. Create a new socket file descriptor.  The file descriptor must
   * be opened in non-blocking mode (so that reads and writes never block).
   * Recommended other options would be to disable signals on write errors
   * (SO_NOSIGPIPE), Disable the Nagle algorithm on SOCK_STREAM (TCP_NODELAY),
   * and to automatically close file descriptors on exec (FD_CLOEXEC).
   *
   *  \param[in] domain      Socket domain. Valid values are AF_INET, AF_INET6.
   *  \param[in] type       Socket type. Valid values are SOCK_STREAM (tcp) and
   *                        SOCK_DGRAM (udp).
   *  \param[in] protocol   In general this should be ignored, may be passed as
   *                        0 (use as default for type), or may be IPPROTO_UDP
   *                        or IPPROTO_TCP.
   *  \param[in] user_data  Pointer provided to ares_set_socket_functions_ex().
   *  \return ARES_SOCKET_BAD on error, or socket file descriptor on success.
   *          On error, it is expected to set errno (or WSASetLastError()) to an
   *          appropriate reason code such as EAFNOSUPPORT / WSAAFNOSUPPORT. */
  ares_socket_t (*asocket)(int domain, int type, int protocol, void *user_data);

  /*! REQUIRED. Close a socket file descriptor.
   *  \param[in] sock      Socket file descriptor returned from asocket.
   *  \param[in] user_data Pointer provided to ares_set_socket_functions_ex().
   *  \return 0 on success.  On failure, should set errno (or WSASetLastError)
   *          to an appropriate code such as EBADF / WSAEBADF */
  int (*aclose)(ares_socket_t sock, void *user_data);


  /*! REQUIRED. Set socket option.  This shares a similar syntax to the BSD
   *  setsockopt() call, however we use our own options.  The value is typically
   *  a pointer to the desired value and each option has its own data type it
   *  will express in the documentation.
   *
   * \param[in] sock         Socket file descriptor returned from asocket.
   * \param[in] opt          Option to set.
   * \param[in] val          Pointer to value for option.
   * \param[in] val_size     Size of value.
   * \param[in] user_data    Pointer provided to
   * ares_set_socket_functions_ex().
   * \return Return 0 on success, otherwise -1 should be returned with an
   *         appropriate errno (or WSASetLastError()) set.  If error is ENOSYS /
   *         WSAEOPNOTSUPP an error will not be propagated as it will take it
   *         to mean it is an intentional decision to not support the feature.
   */
  int (*asetsockopt)(ares_socket_t sock, ares_socket_opt_t opt, const void *val,
                     ares_socklen_t val_size, void *user_data);

  /*! REQUIRED. Connect to the remote using the supplied address.  For UDP
   * sockets this will bind the file descriptor to only send and receive packets
   * from the remote address provided.
   *
   *  \param[in] sock         Socket file descriptor returned from asocket.
   *  \param[in] address      Address to connect to
   *  \param[in] address_len  Size of address structure passed
   *  \param[in] flags        One or more ares_socket_connect_flags_t
   *  \param[in] user_data    Pointer provided to
   * ares_set_socket_functions_ex().
   *  \return Return 0 upon successful establishement, otherwise -1 should be
   *          returned with an appropriate errno (or WSASetLastError()) set.  It
   * is generally expected that most TCP connections (not using TCP Fast Open)
   * will return -1 with an error of EINPROGRESS / WSAEINPROGRESS due to the
   * non-blocking nature of the connection.  It is then the responsibility of
   * the implementation to notify of writability on the socket to indicate the
   * connection has succeeded (or readability on failure to retrieve the
   * appropriate error).
   */
  int (*aconnect)(ares_socket_t sock, const struct sockaddr *address,
                  ares_socklen_t address_len, unsigned int flags,
                  void *user_data);

  /*! REQUIRED. Attempt to read data from the remote.
   *
   *  \param[in]     sock        Socket file descriptor returned from asocket.
   *  \param[in,out] buffer      Allocated buffer to place data read from
   * socket.
   *  \param[in]     length      Size of buffer
   *  \param[in]     flags       Unused, always 0.
   *  \param[in,out] address     Buffer to hold address data was received from.
   *                             May be NULL if address not desired.
   *  \param[in,out] address_len Input size of address buffer, output actual
   *                             written size. Must be NULL if address is NULL.
   *  \param[in]     user_data   Pointer provided to
   * ares_set_socket_functions_ex().
   *  \return -1 on error with appropriate errno (or WSASetLastError()) set,
   * such as EWOULDBLOCK / EAGAIN / WSAEWOULDBLOCK, or ECONNRESET /
   * WSAECONNRESET.
   */
  ares_ssize_t (*arecvfrom)(ares_socket_t sock, void *buffer, size_t length,
                            int flags, struct sockaddr *address,
                            ares_socklen_t *address_len, void *user_data);

  /*! REQUIRED. Attempt to send data to the remote.  Optional address may be
   * specified which may be useful on unbound UDP sockets (though currently not
   * used), and TCP FastOpen where the connection is delayed until first write.
   *
   *  \param[in]     sock        Socket file descriptor returned from asocket.
   *  \param[in]     buffer      Containing data to place onto wire.
   *  \param[in]     length      Size of buffer
   *  \param[in]     flags       Flags for writing.  Currently only used flag is
   *                             MSG_NOSIGNAL if the host OS has such a flag. In
   *                             general flags can be ignored.
   *  \param[in]     address     Buffer containing address to send data to.  May
   *                             be NULL.
   *  \param[in,out] address_len Size of address buffer.  Must be 0 if address
   *                             is NULL.
   *  \param[in]     user_data   Pointer provided to
   * ares_set_socket_functions_ex().
   *  \return Number of bytes written. -1 on error with appropriate errno (or
   * WSASetLastError()) set.
   */
  ares_ssize_t (*asendto)(ares_socket_t sock, const void *buffer, size_t length,
                          int flags, const struct sockaddr *address,
                          ares_socklen_t address_len, void *user_data);

  /*! Optional. Retrieve the local address of the socket.
   *
   *  \param[in]     sock        Socket file descriptor returned from asocket
   *  \param[in,out] address     Buffer to hold address
   *  \param[in,out] address_len Size of address buffer on input, written size
   * on output.
   *  \param[in]     user_data   Pointer provided to
   * ares_set_socket_functions_ex().
   *  \return 0 on success. -1 on error with an appropriate errno (or
   * WSASetLastError()) set.
   */
  int (*agetsockname)(ares_socket_t sock, struct sockaddr *address,
                      ares_socklen_t *address_len, void *user_data);

  /*! Optional. Bind the socket to an address.  This can be used for client
   *  connections to bind the source address for packets before connect, or
   *  for server connections to bind to an address and port before listening.
   *  Currently c-ares only supports client connections.
   *
   *  \param[in] sock        Socket file descriptor returned from asocket
   *  \param[in] flags       ares_socket_bind_flags_t flags.
   *  \param[in] address     Buffer containing address.
   *  \param[in] address_len Size of address buffer.
   *  \param[in] user_data   Pointer provided to
   * ares_set_socket_functions_ex().
   *  \return 0 on success. -1 on error with an appropriate errno (or
   * WSASetLastError()) set.
   */
  int (*abind)(ares_socket_t sock, unsigned int flags,
               const struct sockaddr *address, socklen_t address_len,
               void *user_data);

  /* Optional. Convert an interface name into the interface index.  If this
   * callback is not specified, then IPv6 Link-Local DNS servers cannot be used.
   *
   * \param[in] ifname  Interface Name as NULL-terminated string.
   * \param[in] user_data Pointer provided to
   * ares_set_socket_functions_ex().
   * \return 0 on failure, otherwise interface index.
   */
  unsigned int (*aif_nametoindex)(const char *ifname, void *user_data);

  /* Optional. Convert an interface index into the interface name.  If this
   * callback is not specified, then IPv6 Link-Local DNS servers cannot be used.
   *
   * \param[in] ifindex        Interface index, must be > 0
   * \param[in] ifname_buf     Buffer to hold interface name. Must be at least
   *                           IFNAMSIZ in length or 32 bytes if IFNAMSIZ isn't
   *                           defined.
   * \param[in] ifname_buf_len Size of ifname_buf for verification.
   * \param[in] user_data      Pointer provided to
   * ares_set_socket_functions_ex().
   * \return NULL on failure, otherwise pointer to provided ifname_buf
   */
  const char *(*aif_indextoname)(unsigned int ifindex, char *ifname_buf,
                                 size_t ifname_buf_len, void *user_data);
};

/*! Override the native socket functions for the OS with the provided set.
 *  An optional user data thunk may be specified which will be passed to
 *  each registered callback.  Replaces ares_set_socket_functions().
 *
 *  \param[in] channel   An initialized c-ares channel.
 *  \param[in] funcs     Structure registering the implementations for the
 *                       various functions.  See the structure definition.
 *                       This will be duplicated and does not need to exist
 *                       past the life of this call.
 *  \param[in] user_data User data thunk which will be passed to each call of
 *                       the registered callbacks.
 *  \return ARES_SUCCESS on success, or another error code such as ARES_EFORMERR
 *          on misuse.
 */
CARES_EXTERN ares_status_t ares_set_socket_functions_ex(
  ares_channel_t *channel, const struct ares_socket_functions_ex *funcs,
  void *user_data);


CARES_EXTERN CARES_DEPRECATED_FOR(ares_send_dnsrec) void ares_send(
  ares_channel_t *channel, const unsigned char *qbuf, int qlen,
  ares_callback callback, void *arg);

/*! Send a DNS query as an ares_dns_record_t with a callback containing the
 *  parsed DNS record.
 *
 *  \param[in]  channel  Pointer to channel on which queries will be sent.
 *  \param[in]  dnsrec   DNS Record to send
 *  \param[in]  callback Callback function invoked on completion or failure of
 *                       the query sequence.
 *  \param[in]  arg      Additional argument passed to the callback function.
 *  \param[out] qid      Query ID
 *  \return One of the c-ares status codes.
 */
CARES_EXTERN ares_status_t ares_send_dnsrec(ares_channel_t          *channel,
                                            const ares_dns_record_t *dnsrec,
                                            ares_callback_dnsrec     callback,
                                            void *arg, unsigned short *qid);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_query_dnsrec) void ares_query(
  ares_channel_t *channel, const char *name, int dnsclass, int type,
  ares_callback callback, void *arg);

/*! Perform a DNS query with a callback containing the parsed DNS record.
 *
 *  \param[in]  channel  Pointer to channel on which queries will be sent.
 *  \param[in]  name     Query name
 *  \param[in]  dnsclass DNS Class
 *  \param[in]  type     DNS Record Type
 *  \param[in]  callback Callback function invoked on completion or failure of
 *                       the query sequence.
 *  \param[in]  arg      Additional argument passed to the callback function.
 *  \param[out] qid      Query ID
 *  \return One of the c-ares status codes.
 */
CARES_EXTERN ares_status_t ares_query_dnsrec(ares_channel_t      *channel,
                                             const char          *name,
                                             ares_dns_class_t     dnsclass,
                                             ares_dns_rec_type_t  type,
                                             ares_callback_dnsrec callback,
                                             void *arg, unsigned short *qid);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_search_dnsrec) void ares_search(
  ares_channel_t *channel, const char *name, int dnsclass, int type,
  ares_callback callback, void *arg);

/*! Search for a complete DNS message.
 *
 *  \param[in] channel  Pointer to channel on which queries will be sent.
 *  \param[in] dnsrec   Pointer to initialized and filled DNS record object.
 *  \param[in] callback Callback function invoked on completion or failure of
 *                      the query sequence.
 *  \param[in] arg      Additional argument passed to the callback function.
 *  \return One of the c-ares status codes.  In all cases, except
 *          ARES_EFORMERR due to misuse, this error code will also be sent
 *          to the provided callback.
 */
CARES_EXTERN ares_status_t ares_search_dnsrec(ares_channel_t          *channel,
                                              const ares_dns_record_t *dnsrec,
                                              ares_callback_dnsrec     callback,
                                              void                    *arg);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_getaddrinfo) void ares_gethostbyname(
  ares_channel_t *channel, const char *name, int family,
  ares_host_callback callback, void *arg);

CARES_EXTERN int  ares_gethostbyname_file(ares_channel_t *channel,
                                          const char *name, int family,
                                          struct hostent **host);

CARES_EXTERN void ares_gethostbyaddr(ares_channel_t *channel, const void *addr,
                                     int addrlen, int family,
                                     ares_host_callback callback, void *arg);

CARES_EXTERN void ares_getnameinfo(ares_channel_t        *channel,
                                   const struct sockaddr *sa,
                                   ares_socklen_t salen, int flags,
                                   ares_nameinfo_callback callback, void *arg);

CARES_EXTERN      CARES_DEPRECATED_FOR(
  ARES_OPT_EVENT_THREAD or
  ARES_OPT_SOCK_STATE_CB) int ares_fds(const ares_channel_t *channel,
                                            fd_set *read_fds, fd_set *write_fds);

CARES_EXTERN CARES_DEPRECATED_FOR(
  ARES_OPT_EVENT_THREAD or
  ARES_OPT_SOCK_STATE_CB) int ares_getsock(const ares_channel_t *channel,
                                           ares_socket_t *socks, int numsocks);

CARES_EXTERN struct timeval *ares_timeout(const ares_channel_t *channel,
                                          struct timeval       *maxtv,
                                          struct timeval       *tv);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_process_fds) void ares_process(
  ares_channel_t *channel, fd_set *read_fds, fd_set *write_fds);

/*! Events used by ares_fd_events_t */
typedef enum {
  ARES_FD_EVENT_NONE  = 0,      /*!< No events */
  ARES_FD_EVENT_READ  = 1 << 0, /*!< Read event (including disconnect/error) */
  ARES_FD_EVENT_WRITE = 1 << 1  /*!< Write event */
} ares_fd_eventflag_t;

/*! Type holding a file descriptor and mask of events, used by
 *  ares_process_fds() */
typedef struct {
  ares_socket_t fd;     /*!< File descriptor */
  unsigned int  events; /*!< Mask of ares_fd_eventflag_t */
} ares_fd_events_t;

/*! Flags used by ares_process_fds() */
typedef enum {
  ARES_PROCESS_FLAG_NONE        = 0,     /*!< No flag value */
  ARES_PROCESS_FLAG_SKIP_NON_FD = 1 << 0 /*!< skip any processing unrelated to
                                          *   the file descriptor events passed
                                          *    in */
} ares_process_flag_t;

/*! Process events on multiple file descriptors based on the event mask
 *  associated with each file descriptor.  Recommended over calling
 *  ares_process_fd() multiple times since it would trigger additional logic
 *  such as timeout processing on each call.
 *
 *  \param[in] channel  Initialized ares channel
 *  \param[in] events   Array of file descriptors with events.  May be NULL if
 *                      no events, but may have timeouts to process.
 *  \param[in] nevents  Number of elements in the events array.  May be 0 if
 *                      no events, but may have timeouts to process.
 *  \param[in] flags    Flags to alter behavior of the process command.
 *  \return ARES_ENOMEM on out of memory, ARES_EFORMERR on misuse,
 *          otherwise ARES_SUCCESS
 */
CARES_EXTERN ares_status_t ares_process_fds(ares_channel_t         *channel,
                                            const ares_fd_events_t *events,
                                            size_t nevents, unsigned int flags);

CARES_EXTERN void          ares_process_fd(ares_channel_t *channel,
                                           ares_socket_t   read_fd,
                                           ares_socket_t   write_fd);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_record_create) int ares_create_query(
  const char *name, int dnsclass, int type, unsigned short id, int rd,
  unsigned char **buf, int *buflen, int max_udp_size);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_record_create) int ares_mkquery(
  const char *name, int dnsclass, int type, unsigned short id, int rd,
  unsigned char **buf, int *buflen);

CARES_EXTERN int ares_expand_name(const unsigned char *encoded,
                                  const unsigned char *abuf, int alen, char **s,
                                  long *enclen);

CARES_EXTERN int ares_expand_string(const unsigned char *encoded,
                                    const unsigned char *abuf, int alen,
                                    unsigned char **s, long *enclen);

struct ares_addrttl {
  struct in_addr ipaddr;
  int            ttl;
};

struct ares_addr6ttl {
  struct ares_in6_addr ip6addr;
  int                  ttl;
};

struct ares_caa_reply {
  struct ares_caa_reply *next;
  int                    critical;
  unsigned char         *property;
  size_t                 plength; /* plength excludes null termination */
  unsigned char         *value;
  size_t                 length;  /* length excludes null termination */
};

struct ares_srv_reply {
  struct ares_srv_reply *next;
  char                  *host;
  unsigned short         priority;
  unsigned short         weight;
  unsigned short         port;
};

struct ares_mx_reply {
  struct ares_mx_reply *next;
  char                 *host;
  unsigned short        priority;
};

struct ares_txt_reply {
  struct ares_txt_reply *next;
  unsigned char         *txt;
  size_t                 length; /* length excludes null termination */
};

/* NOTE: This structure is a superset of ares_txt_reply
 */
struct ares_txt_ext {
  struct ares_txt_ext *next;
  unsigned char       *txt;
  size_t               length;
  /* 1 - if start of new record
   * 0 - if a chunk in the same record */
  unsigned char        record_start;
};

struct ares_naptr_reply {
  struct ares_naptr_reply *next;
  unsigned char           *flags;
  unsigned char           *service;
  unsigned char           *regexp;
  char                    *replacement;
  unsigned short           order;
  unsigned short           preference;
};

struct ares_soa_reply {
  char        *nsname;
  char        *hostmaster;
  unsigned int serial;
  unsigned int refresh;
  unsigned int retry;
  unsigned int expire;
  unsigned int minttl;
};

struct ares_uri_reply {
  struct ares_uri_reply *next;
  unsigned short         priority;
  unsigned short         weight;
  char                  *uri;
  int                    ttl;
};

/*
 * Similar to addrinfo, but with extra ttl and missing canonname.
 */
struct ares_addrinfo_node {
  int                        ai_ttl;
  int                        ai_flags;
  int                        ai_family;
  int                        ai_socktype;
  int                        ai_protocol;
  ares_socklen_t             ai_addrlen;
  struct sockaddr           *ai_addr;
  struct ares_addrinfo_node *ai_next;
};

/*
 * alias - label of the resource record.
 * name - value (canonical name) of the resource record.
 * See RFC2181 10.1.1. CNAME terminology.
 */
struct ares_addrinfo_cname {
  int                         ttl;
  char                       *alias;
  char                       *name;
  struct ares_addrinfo_cname *next;
};

struct ares_addrinfo {
  struct ares_addrinfo_cname *cnames;
  struct ares_addrinfo_node  *nodes;
  char                       *name;
};

struct ares_addrinfo_hints {
  int ai_flags;
  int ai_family;
  int ai_socktype;
  int ai_protocol;
};

/*
** Parse the buffer, starting at *abuf and of length alen bytes, previously
** obtained from an ares_search call.  Put the results in *host, if nonnull.
** Also, if addrttls is nonnull, put up to *naddrttls IPv4 addresses along with
** their TTLs in that array, and set *naddrttls to the number of addresses
** so written.
*/

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_a_reply(
  const unsigned char *abuf, int alen, struct hostent **host,
  struct ares_addrttl *addrttls, int *naddrttls);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_aaaa_reply(
  const unsigned char *abuf, int alen, struct hostent **host,
  struct ares_addr6ttl *addrttls, int *naddrttls);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_caa_reply(
  const unsigned char *abuf, int alen, struct ares_caa_reply **caa_out);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_ptr_reply(
  const unsigned char *abuf, int alen, const void *addr, int addrlen,
  int family, struct hostent **host);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_ns_reply(
  const unsigned char *abuf, int alen, struct hostent **host);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_srv_reply(
  const unsigned char *abuf, int alen, struct ares_srv_reply **srv_out);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_mx_reply(
  const unsigned char *abuf, int alen, struct ares_mx_reply **mx_out);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_txt_reply(
  const unsigned char *abuf, int alen, struct ares_txt_reply **txt_out);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_txt_reply_ext(
  const unsigned char *abuf, int alen, struct ares_txt_ext **txt_out);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_naptr_reply(
  const unsigned char *abuf, int alen, struct ares_naptr_reply **naptr_out);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_soa_reply(
  const unsigned char *abuf, int alen, struct ares_soa_reply **soa_out);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_dns_parse) int ares_parse_uri_reply(
  const unsigned char *abuf, int alen, struct ares_uri_reply **uri_out);

CARES_EXTERN void        ares_free_string(void *str);

CARES_EXTERN void        ares_free_hostent(struct hostent *host);

CARES_EXTERN void        ares_free_data(void *dataptr);

CARES_EXTERN const char *ares_strerror(int code);

struct ares_addr_node {
  struct ares_addr_node *next;
  int                    family;

  union {
    struct in_addr       addr4;
    struct ares_in6_addr addr6;
  } addr;
};

struct ares_addr_port_node {
  struct ares_addr_port_node *next;
  int                         family;

  union {
    struct in_addr       addr4;
    struct ares_in6_addr addr6;
  } addr;

  int udp_port;
  int tcp_port;
};

CARES_EXTERN CARES_DEPRECATED_FOR(ares_set_servers_csv) int ares_set_servers(
  ares_channel_t *channel, const struct ares_addr_node *servers);

CARES_EXTERN
CARES_DEPRECATED_FOR(ares_set_servers_ports_csv)
int                ares_set_servers_ports(ares_channel_t                   *channel,
                                          const struct ares_addr_port_node *servers);

/* Incoming string format: host[:port][,host[:port]]... */
CARES_EXTERN int   ares_set_servers_csv(ares_channel_t *channel,
                                        const char     *servers);
CARES_EXTERN int   ares_set_servers_ports_csv(ares_channel_t *channel,
                                              const char     *servers);
CARES_EXTERN char *ares_get_servers_csv(const ares_channel_t *channel);

CARES_EXTERN CARES_DEPRECATED_FOR(ares_get_servers_csv) int ares_get_servers(
  const ares_channel_t *channel, struct ares_addr_node **servers);

CARES_EXTERN
CARES_DEPRECATED_FOR(ares_get_servers_csv)
int                        ares_get_servers_ports(const ares_channel_t        *channel,
                                                  struct ares_addr_port_node **servers);

CARES_EXTERN const char   *ares_inet_ntop(int af, const void *src, char *dst,
                                          ares_socklen_t size);

CARES_EXTERN int           ares_inet_pton(int af, const char *src, void *dst);

/*! Whether or not the c-ares library was built with threadsafety
 *
 *  \return ARES_TRUE if built with threadsafety, ARES_FALSE if not
 */
CARES_EXTERN ares_bool_t   ares_threadsafety(void);


/*! Block until notified that there are no longer any queries in queue, or
 *  the specified timeout has expired.
 *
 *  \param[in] channel    Initialized ares channel
 *  \param[in] timeout_ms Number of milliseconds to wait for the queue to be
 *                        empty. -1 for Infinite.
 *  \return ARES_ENOTIMP if not built with threading support, ARES_ETIMEOUT
 *          if requested timeout expires, ARES_SUCCESS when queue is empty.
 */
CARES_EXTERN ares_status_t ares_queue_wait_empty(ares_channel_t *channel,
                                                 int             timeout_ms);


/*! Retrieve the total number of active queries pending answers from servers.
 *  Some c-ares requests may spawn multiple queries, such as ares_getaddrinfo()
 *  when using AF_UNSPEC, which will be reflected in this number.
 *
 *  \param[in] channel Initialized ares channel
 *  \return Number of active queries to servers
 */
CARES_EXTERN size_t ares_queue_active_queries(const ares_channel_t *channel);

#ifdef __cplusplus
}
#endif

#endif /* ARES__H */
