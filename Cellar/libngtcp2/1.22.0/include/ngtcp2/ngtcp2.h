/*
 * ngtcp2
 *
 * Copyright (c) 2017 ngtcp2 contributors
 * Copyright (c) 2017 nghttp2 contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
#ifndef NGTCP2_H
#define NGTCP2_H

/* Define WIN32 when build target is Win32 API (borrowed from
   libcurl) */
#if (defined(_WIN32) || defined(__WIN32__)) && !defined(WIN32)
#  define WIN32
#endif /* (defined(_WIN32) || defined(__WIN32__)) && !defined(WIN32) */

#ifdef _MSC_VER
#  pragma warning(push)
#  pragma warning(disable : 4324)
#endif /* defined(_MSC_VER) */

#include <stdlib.h>
#if defined(_MSC_VER) && (_MSC_VER < 1800)
/* MSVC < 2013 does not have inttypes.h because it is not C99
   compliant.  See compiler macros and version number in
   https://sourceforge.net/p/predef/wiki/Compilers/ */
#  include <stdint.h>
#else /* !(defined(_MSC_VER) && (_MSC_VER < 1800)) */
#  include <inttypes.h>
#endif /* !(defined(_MSC_VER) && (_MSC_VER < 1800)) */
#include <sys/types.h>
#include <stdarg.h>
#include <stddef.h>

#ifndef NGTCP2_USE_GENERIC_SOCKADDR
#  ifdef WIN32
#    ifndef WIN32_LEAN_AND_MEAN
#      define WIN32_LEAN_AND_MEAN
#    endif /* !defined(WIN32_LEAN_AND_MEAN) */
#    include <ws2tcpip.h>
#  else /* !defined(WIN32) */
#    include <sys/socket.h>
#    include <netinet/in.h>
#  endif /* !defined(WIN32) */
#endif   /* !defined(NGTCP2_USE_GENERIC_SOCKADDR) */

#include <ngtcp2/version.h>

#ifdef NGTCP2_STATICLIB
#  define NGTCP2_EXTERN
#elif defined(WIN32)
#  ifdef BUILDING_NGTCP2
#    define NGTCP2_EXTERN __declspec(dllexport)
#  else /* !defined(BUILDING_NGTCP2) */
#    define NGTCP2_EXTERN __declspec(dllimport)
#  endif /* !defined(BUILDING_NGTCP2) */
#else    /* !(defined(NGTCP2_STATICLIB) || defined(WIN32)) */
#  ifdef BUILDING_NGTCP2
#    define NGTCP2_EXTERN __attribute__((visibility("default")))
#  else /* !defined(BUILDING_NGTCP2) */
#    define NGTCP2_EXTERN
#  endif /* !defined(BUILDING_NGTCP2) */
#endif   /* !(defined(NGTCP2_STATICLIB) || defined(WIN32)) */

#ifdef _MSC_VER
#  define NGTCP2_ALIGN(N) __declspec(align(N))
#else /* !defined(_MSC_VER) */
#  define NGTCP2_ALIGN(N) __attribute__((aligned(N)))
#endif /* !defined(_MSC_VER) */

#ifdef __cplusplus
extern "C" {
#endif /* defined(__cplusplus) */

/**
 * @typedef
 *
 * :type:`ngtcp2_ssize` is signed counterpart of size_t.
 */
typedef ptrdiff_t ngtcp2_ssize;

/**
 * @functypedef
 *
 * :type:`ngtcp2_malloc` is a custom memory allocator to replace
 * :manpage:`malloc(3)`.  The |user_data| is
 * :member:`ngtcp2_mem.user_data`.
 */
typedef void *(*ngtcp2_malloc)(size_t size, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_free` is a custom memory allocator to replace
 * :manpage:`free(3)`.  The |user_data| is
 * :member:`ngtcp2_mem.user_data`.
 */
typedef void (*ngtcp2_free)(void *ptr, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_calloc` is a custom memory allocator to replace
 * :manpage:`calloc(3)`.  The |user_data| is the
 * :member:`ngtcp2_mem.user_data`.
 */
typedef void *(*ngtcp2_calloc)(size_t nmemb, size_t size, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_realloc` is a custom memory allocator to replace
 * :manpage:`realloc(3)`.  The |user_data| is the
 * :member:`ngtcp2_mem.user_data`.
 */
typedef void *(*ngtcp2_realloc)(void *ptr, size_t size, void *user_data);

/**
 * @struct
 *
 * :type:`ngtcp2_mem` is a custom memory allocator.  The
 * :member:`user_data` field is passed to each allocator function.
 * This can be used, for example, to achieve per-connection memory
 * pool.
 *
 * In the following example code, ``my_malloc``, ``my_free``,
 * ``my_calloc`` and ``my_realloc`` are the replacement of the
 * standard allocators :manpage:`malloc(3)`, :manpage:`free(3)`,
 * :manpage:`calloc(3)` and :manpage:`realloc(3)` respectively::
 *
 *     void *my_malloc_cb(size_t size, void *user_data) {
 *       (void)user_data;
 *       return my_malloc(size);
 *     }
 *
 *     void my_free_cb(void *ptr, void *user_data) {
 *       (void)user_data;
 *       my_free(ptr);
 *     }
 *
 *     void *my_calloc_cb(size_t nmemb, size_t size, void *user_data) {
 *       (void)user_data;
 *       return my_calloc(nmemb, size);
 *     }
 *
 *     void *my_realloc_cb(void *ptr, size_t size, void *user_data) {
 *       (void)user_data;
 *       return my_realloc(ptr, size);
 *     }
 *
 *     void conn_new() {
 *       ngtcp2_mem mem = {
 *         .malloc = my_malloc_cb,
 *         .free = my_free_cb,
 *         .calloc = my_calloc_cb,
 *         .realloc = my_realloc_cb,
 *       };
 *
 *       ...
 *     }
 */
typedef struct ngtcp2_mem {
  /**
   * :member:`user_data` is an arbitrary user supplied data.  This
   * is passed to each allocator function.
   */
  void *user_data;
  /**
   * :member:`malloc` is a custom allocator function to replace
   * :manpage:`malloc(3)`.
   */
  ngtcp2_malloc malloc;
  /**
   * :member:`free` is a custom allocator function to replace
   * :manpage:`free(3)`.
   */
  ngtcp2_free free;
  /**
   * :member:`calloc` is a custom allocator function to replace
   * :manpage:`calloc(3)`.
   */
  ngtcp2_calloc calloc;
  /**
   * :member:`realloc` is a custom allocator function to replace
   * :manpage:`realloc(3)`.
   */
  ngtcp2_realloc realloc;
} ngtcp2_mem;

/**
 * @macrosection
 *
 * Time related macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_NANOSECONDS` is a count of tick which corresponds to
 * 1 nanosecond.
 */
#define NGTCP2_NANOSECONDS ((ngtcp2_duration)1ULL)

/**
 * @macro
 *
 * :macro:`NGTCP2_MICROSECONDS` is a count of tick which corresponds
 * to 1 microsecond.
 */
#define NGTCP2_MICROSECONDS ((ngtcp2_duration)(1000ULL * NGTCP2_NANOSECONDS))

/**
 * @macro
 *
 * :macro:`NGTCP2_MILLISECONDS` is a count of tick which corresponds
 * to 1 millisecond.
 */
#define NGTCP2_MILLISECONDS ((ngtcp2_duration)(1000ULL * NGTCP2_MICROSECONDS))

/**
 * @macro
 *
 * :macro:`NGTCP2_SECONDS` is a count of tick which corresponds to 1
 * second.
 */
#define NGTCP2_SECONDS ((ngtcp2_duration)(1000ULL * NGTCP2_MILLISECONDS))

/**
 * @macro
 *
 * :macro:`NGTCP2_MINUTES` is a count of tick which corresponds to 1
 * minute.
 */
#define NGTCP2_MINUTES ((ngtcp2_duration)(60ULL * NGTCP2_SECONDS))

/**
 * @macrosection
 *
 * QUIC protocol version macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_PROTO_VER_V1` is the QUIC version 1.
 */
#define NGTCP2_PROTO_VER_V1 ((uint32_t)0x00000001U)

/**
 * @macro
 *
 * :macro:`NGTCP2_PROTO_VER_V2` is the QUIC version 2.  See
 * :rfc:`9369`.
 */
#define NGTCP2_PROTO_VER_V2 ((uint32_t)0x6B3343CFU)

/**
 * @macro
 *
 * :macro:`NGTCP2_PROTO_VER_MAX` is the highest QUIC version that this
 * library supports.  Deprecated since v1.1.0.
 */
#define NGTCP2_PROTO_VER_MAX NGTCP2_PROTO_VER_V1

/**
 * @macro
 *
 * :macro:`NGTCP2_PROTO_VER_MIN` is the lowest QUIC version that this
 * library supports.  Deprecated since v1.1.0.
 */
#define NGTCP2_PROTO_VER_MIN NGTCP2_PROTO_VER_V1

/**
 * @macro
 *
 * :macro:`NGTCP2_RESERVED_VERSION_MASK` is the bit mask of reserved
 * version.
 */
#define NGTCP2_RESERVED_VERSION_MASK 0x0A0A0A0AU

/**
 * @macrosection
 *
 * UDP datagram related macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_MAX_UDP_PAYLOAD_SIZE` is the default maximum UDP
 * datagram payload size that the local endpoint transmits without
 * Path MTU Discovery (PMTUD) or the custom settings (see
 * :member:`ngtcp2_settings.max_tx_udp_payload_size` and
 * :member:`ngtcp2_settings.no_tx_udp_payload_size_shaping`).
 */
#define NGTCP2_MAX_UDP_PAYLOAD_SIZE 1200

/**
 * @macro
 *
 * :macro:`NGTCP2_MAX_TX_UDP_PAYLOAD_SIZE` is the maximum UDP datagram
 * payload size that this library can output.
 */
#define NGTCP2_MAX_TX_UDP_PAYLOAD_SIZE 65527

/**
 * @macro
 *
 * :macro:`NGTCP2_MAX_PMTUD_UDP_PAYLOAD_SIZE` was the maximum UDP
 * datagram payload size that Path MTU Discovery can discover.
 *
 * Deprecated since v1.17.0.  Path MTU Discovery is not capped to this
 * value anymore.
 */
#define NGTCP2_MAX_PMTUD_UDP_PAYLOAD_SIZE 1452

/**
 * @macrosection
 *
 * QUIC specific macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_MAX_VARINT` is the maximum value which can be
 * encoded in variable-length integer encoding.
 */
#define NGTCP2_MAX_VARINT ((1ULL << 62) - 1)

/**
 * @macro
 *
 * :macro:`NGTCP2_STATELESS_RESET_TOKENLEN` is the length of Stateless
 * Reset Token.
 */
#define NGTCP2_STATELESS_RESET_TOKENLEN 16

/**
 * @macro
 *
 * :macro:`NGTCP2_MIN_STATELESS_RESET_RANDLEN` is the minimum length
 * of random bytes (Unpredictable Bits) in Stateless Reset packet.
 */
#define NGTCP2_MIN_STATELESS_RESET_RANDLEN 5

/**
 * @macro
 *
 * :macro:`NGTCP2_PATH_CHALLENGE_DATALEN` is the length of
 * PATH_CHALLENGE data.
 */
#define NGTCP2_PATH_CHALLENGE_DATALEN 8

/**
 * @macro
 *
 * :macro:`NGTCP2_RETRY_KEY_V1` is an encryption key to create
 * integrity tag of Retry packet.  It is used for QUIC v1.
 */
#define NGTCP2_RETRY_KEY_V1                                                    \
  "\xBE\x0C\x69\x0B\x9F\x66\x57\x5A\x1D\x76\x6B\x54\xE3\x68\xC8\x4E"

/**
 * @macro
 *
 * :macro:`NGTCP2_RETRY_NONCE_V1` is nonce used when generating
 * integrity tag of Retry packet.  It is used for QUIC v1.
 */
#define NGTCP2_RETRY_NONCE_V1 "\x46\x15\x99\xD3\x5D\x63\x2B\xF2\x23\x98\x25\xBB"

/**
 * @macro
 *
 * :macro:`NGTCP2_RETRY_KEY_V2` is an encryption key to create
 * integrity tag of Retry packet.  It is used for QUIC v2.  See
 * :rfc:`9369`.
 */
#define NGTCP2_RETRY_KEY_V2                                                    \
  "\x8F\xB4\xB0\x1B\x56\xAC\x48\xE2\x60\xFB\xCB\xCE\xAD\x7C\xCC\x92"

/**
 * @macro
 *
 * :macro:`NGTCP2_RETRY_NONCE_V2` is nonce used when generating
 * integrity tag of Retry packet.  It is used for QUIC v2.  See
 * :rfc:`9369`.
 */
#define NGTCP2_RETRY_NONCE_V2 "\xD8\x69\x69\xBC\x2D\x7C\x6D\x99\x90\xEF\xB0\x4A"

/**
 * @macro
 *
 * :macro:`NGTCP2_HP_MASKLEN` is the length of header protection mask.
 */
#define NGTCP2_HP_MASKLEN 5

/**
 * @macro
 *
 * :macro:`NGTCP2_HP_SAMPLELEN` is the number bytes sampled when
 * encrypting a packet header.
 */
#define NGTCP2_HP_SAMPLELEN 16

/**
 * @macro
 *
 * :macro:`NGTCP2_DEFAULT_INITIAL_RTT` is a default initial RTT.
 */
#define NGTCP2_DEFAULT_INITIAL_RTT (333 * NGTCP2_MILLISECONDS)

/**
 * @macro
 *
 * :macro:`NGTCP2_MAX_CIDLEN` is the maximum length of Connection ID.
 */
#define NGTCP2_MAX_CIDLEN 20

/**
 * @macro
 *
 * :macro:`NGTCP2_MIN_CIDLEN` is the minimum length of Connection ID.
 */
#define NGTCP2_MIN_CIDLEN 1

/**
 * @macro
 *
 * :macro:`NGTCP2_MIN_INITIAL_DCIDLEN` is the minimum length of
 * Destination Connection ID in Client Initial packet if it does not
 * bear token from Retry packet.
 */
#define NGTCP2_MIN_INITIAL_DCIDLEN 8

/**
 * @macrosection
 *
 * ECN related macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_ECN_NOT_ECT` indicates no ECN marking.
 */
#define NGTCP2_ECN_NOT_ECT 0x0

/**
 * @macro
 *
 * :macro:`NGTCP2_ECN_ECT_1` is ECT(1) codepoint.
 */
#define NGTCP2_ECN_ECT_1 0x1

/**
 * @macro
 *
 * :macro:`NGTCP2_ECN_ECT_0` is ECT(0) codepoint.
 */
#define NGTCP2_ECN_ECT_0 0x2

/**
 * @macro
 *
 * :macro:`NGTCP2_ECN_CE` is CE codepoint.
 */
#define NGTCP2_ECN_CE 0x3

/**
 * @macro
 *
 * :macro:`NGTCP2_ECN_MASK` is a bit mask to get ECN marking.
 */
#define NGTCP2_ECN_MASK 0x3

#define NGTCP2_PKT_INFO_V1 1
#define NGTCP2_PKT_INFO_VERSION NGTCP2_PKT_INFO_V1

/**
 * @struct
 *
 * :type:`ngtcp2_pkt_info` is a packet metadata.
 */
typedef struct NGTCP2_ALIGN(8) ngtcp2_pkt_info {
  /**
   * :member:`ecn` is ECN marking, and when it is passed to
   * `ngtcp2_conn_read_pkt()`, it should be either
   * :macro:`NGTCP2_ECN_NOT_ECT`, :macro:`NGTCP2_ECN_ECT_1`,
   * :macro:`NGTCP2_ECN_ECT_0`, or :macro:`NGTCP2_ECN_CE`.
   */
  uint8_t ecn;
} ngtcp2_pkt_info;

/**
 * @macrosection
 *
 * ngtcp2 library error codes
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT` indicates that a passed
 * argument is invalid.
 */
#define NGTCP2_ERR_INVALID_ARGUMENT -201
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_NOBUF` indicates that a provided buffer does not
 * have enough space to store data.
 */
#define NGTCP2_ERR_NOBUF -202
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_PROTO` indicates a general protocol error.
 */
#define NGTCP2_ERR_PROTO -203
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_INVALID_STATE` indicates that a requested
 * operation is not allowed at the current connection state.
 */
#define NGTCP2_ERR_INVALID_STATE -204
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_ACK_FRAME` indicates that an invalid ACK frame
 * is received.
 */
#define NGTCP2_ERR_ACK_FRAME -205
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_STREAM_ID_BLOCKED` indicates that there is no
 * spare stream ID available.
 */
#define NGTCP2_ERR_STREAM_ID_BLOCKED -206
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_STREAM_IN_USE` indicates that a stream ID is
 * already in use.
 */
#define NGTCP2_ERR_STREAM_IN_USE -207
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_STREAM_DATA_BLOCKED` indicates that stream data
 * cannot be sent because of flow control.
 */
#define NGTCP2_ERR_STREAM_DATA_BLOCKED -208
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_FLOW_CONTROL` indicates flow control error.
 */
#define NGTCP2_ERR_FLOW_CONTROL -209
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_CONNECTION_ID_LIMIT` indicates that the number
 * of received Connection ID exceeds acceptable limit.
 */
#define NGTCP2_ERR_CONNECTION_ID_LIMIT -210
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_STREAM_LIMIT` indicates that a remote endpoint
 * opens more streams that is permitted.
 */
#define NGTCP2_ERR_STREAM_LIMIT -211
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_FINAL_SIZE` indicates that inconsistent final
 * size of a stream.
 */
#define NGTCP2_ERR_FINAL_SIZE -212
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_CRYPTO` indicates crypto (TLS) related error.
 */
#define NGTCP2_ERR_CRYPTO -213
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_PKT_NUM_EXHAUSTED` indicates that packet number
 * is exhausted.
 */
#define NGTCP2_ERR_PKT_NUM_EXHAUSTED -214
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_REQUIRED_TRANSPORT_PARAM` indicates that a
 * required transport parameter is missing.
 */
#define NGTCP2_ERR_REQUIRED_TRANSPORT_PARAM -215
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_MALFORMED_TRANSPORT_PARAM` indicates that a
 * transport parameter is malformed.
 */
#define NGTCP2_ERR_MALFORMED_TRANSPORT_PARAM -216
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_FRAME_ENCODING` indicates there is an error in
 * frame encoding.
 */
#define NGTCP2_ERR_FRAME_ENCODING -217
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_DECRYPT` indicates a decryption failure.
 */
#define NGTCP2_ERR_DECRYPT -218
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_STREAM_SHUT_WR` indicates no more data can be
 * sent to a stream.
 */
#define NGTCP2_ERR_STREAM_SHUT_WR -219
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_STREAM_NOT_FOUND` indicates that a stream was
 * not found.
 */
#define NGTCP2_ERR_STREAM_NOT_FOUND -220
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_STREAM_STATE` indicates that a requested
 * operation is not allowed at the current stream state.
 */
#define NGTCP2_ERR_STREAM_STATE -221
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_RECV_VERSION_NEGOTIATION` indicates that Version
 * Negotiation packet was received.
 */
#define NGTCP2_ERR_RECV_VERSION_NEGOTIATION -222
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_CLOSING` indicates that connection is in closing
 * state.
 */
#define NGTCP2_ERR_CLOSING -223
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_DRAINING` indicates that connection is in
 * draining state.
 */
#define NGTCP2_ERR_DRAINING -224
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_TRANSPORT_PARAM` indicates a general transport
 * parameter error.
 */
#define NGTCP2_ERR_TRANSPORT_PARAM -225
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_DISCARD_PKT` indicates a packet was discarded.
 */
#define NGTCP2_ERR_DISCARD_PKT -226
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_CONN_ID_BLOCKED` indicates that there is no
 * spare Connection ID available.
 */
#define NGTCP2_ERR_CONN_ID_BLOCKED -227
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_INTERNAL` indicates an internal error.
 */
#define NGTCP2_ERR_INTERNAL -228
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_CRYPTO_BUFFER_EXCEEDED` indicates that a crypto
 * buffer exceeded.
 */
#define NGTCP2_ERR_CRYPTO_BUFFER_EXCEEDED -229
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_WRITE_MORE` indicates
 * :macro:`NGTCP2_WRITE_STREAM_FLAG_MORE` is used and a function call
 * succeeded.
 */
#define NGTCP2_ERR_WRITE_MORE -230
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_RETRY` indicates that server should send Retry
 * packet.
 */
#define NGTCP2_ERR_RETRY -231
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_DROP_CONN` indicates that an endpoint should
 * drop connection immediately.
 */
#define NGTCP2_ERR_DROP_CONN -232
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_AEAD_LIMIT_REACHED` indicates AEAD encryption
 * limit is reached and key update is not available.  An endpoint
 * should drop connection immediately.
 */
#define NGTCP2_ERR_AEAD_LIMIT_REACHED -233
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_NO_VIABLE_PATH` indicates that path validation
 * could not probe that a path is capable of sending UDP datagram
 * payload of size at least 1200 bytes.
 */
#define NGTCP2_ERR_NO_VIABLE_PATH -234
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_VERSION_NEGOTIATION` indicates that server
 * should send Version Negotiation packet.
 */
#define NGTCP2_ERR_VERSION_NEGOTIATION -235
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_HANDSHAKE_TIMEOUT` indicates that QUIC
 * connection is not established before the specified deadline.
 */
#define NGTCP2_ERR_HANDSHAKE_TIMEOUT -236
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_VERSION_NEGOTIATION_FAILURE` indicates the
 * version negotiation failed.
 */
#define NGTCP2_ERR_VERSION_NEGOTIATION_FAILURE -237
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_IDLE_CLOSE` indicates the connection should be
 * closed silently because of idle timeout.
 */
#define NGTCP2_ERR_IDLE_CLOSE -238
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_FATAL` indicates that error codes less than this
 * value is fatal error.  When this error is returned, an endpoint
 * should close connection immediately.
 */
#define NGTCP2_ERR_FATAL -500
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_NOMEM` indicates out of memory.
 */
#define NGTCP2_ERR_NOMEM -501
/**
 * @macro
 *
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` indicates that user defined
 * callback function failed.
 */
#define NGTCP2_ERR_CALLBACK_FAILURE -502

/**
 * @macrosection
 *
 * QUIC packet header flags
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_PKT_FLAG_NONE` indicates no flag set.
 */
#define NGTCP2_PKT_FLAG_NONE 0x00U

/**
 * @macro
 *
 * :macro:`NGTCP2_PKT_FLAG_LONG_FORM` indicates the Long header packet
 * header.
 */
#define NGTCP2_PKT_FLAG_LONG_FORM 0x01U

/**
 * @macro
 *
 * :macro:`NGTCP2_PKT_FLAG_FIXED_BIT_CLEAR` indicates that Fixed Bit
 * (aka QUIC bit) is not set.
 */
#define NGTCP2_PKT_FLAG_FIXED_BIT_CLEAR 0x02U

/**
 * @macro
 *
 * :macro:`NGTCP2_PKT_FLAG_KEY_PHASE` indicates Key Phase bit set.
 */
#define NGTCP2_PKT_FLAG_KEY_PHASE 0x04U

/**
 * @enum
 *
 * :type:`ngtcp2_pkt_type` defines QUIC version-independent QUIC
 * packet types.
 */
typedef enum ngtcp2_pkt_type {
  /**
   * :enum:`NGTCP2_PKT_VERSION_NEGOTIATION` is defined by libngtcp2
   * for convenience.
   */
  NGTCP2_PKT_VERSION_NEGOTIATION = 0x80,
  /**
   * :enum:`NGTCP2_PKT_STATELESS_RESET` is defined by libngtcp2 for
   * convenience.
   */
  NGTCP2_PKT_STATELESS_RESET = 0x81,
  /**
   * :enum:`NGTCP2_PKT_INITIAL` indicates Initial packet.
   */
  NGTCP2_PKT_INITIAL = 0x10,
  /**
   * :enum:`NGTCP2_PKT_0RTT` indicates 0-RTT packet.
   */
  NGTCP2_PKT_0RTT = 0x11,
  /**
   * :enum:`NGTCP2_PKT_HANDSHAKE` indicates Handshake packet.
   */
  NGTCP2_PKT_HANDSHAKE = 0x12,
  /**
   * :enum:`NGTCP2_PKT_RETRY` indicates Retry packet.
   */
  NGTCP2_PKT_RETRY = 0x13,
  /**
   * :enum:`NGTCP2_PKT_1RTT` is defined by libngtcp2 for convenience.
   */
  NGTCP2_PKT_1RTT = 0x40
} ngtcp2_pkt_type;

/**
 * @macrosection
 *
 * QUIC transport error code
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_NO_ERROR` is QUIC transport error code ``NO_ERROR``.
 */
#define NGTCP2_NO_ERROR 0x0U

/**
 * @macro
 *
 * :macro:`NGTCP2_INTERNAL_ERROR` is QUIC transport error code
 * ``INTERNAL_ERROR``.
 */
#define NGTCP2_INTERNAL_ERROR 0x1U

/**
 * @macro
 *
 * :macro:`NGTCP2_CONNECTION_REFUSED` is QUIC transport error code
 * ``CONNECTION_REFUSED``.
 */
#define NGTCP2_CONNECTION_REFUSED 0x2U

/**
 * @macro
 *
 * :macro:`NGTCP2_FLOW_CONTROL_ERROR` is QUIC transport error code
 * ``FLOW_CONTROL_ERROR``.
 */
#define NGTCP2_FLOW_CONTROL_ERROR 0x3U

/**
 * @macro
 *
 * :macro:`NGTCP2_STREAM_LIMIT_ERROR` is QUIC transport error code
 * ``STREAM_LIMIT_ERROR``.
 */
#define NGTCP2_STREAM_LIMIT_ERROR 0x4U

/**
 * @macro
 *
 * :macro:`NGTCP2_STREAM_STATE_ERROR` is QUIC transport error code
 * ``STREAM_STATE_ERROR``.
 */
#define NGTCP2_STREAM_STATE_ERROR 0x5U

/**
 * @macro
 *
 * :macro:`NGTCP2_FINAL_SIZE_ERROR` is QUIC transport error code
 * ``FINAL_SIZE_ERROR``.
 */
#define NGTCP2_FINAL_SIZE_ERROR 0x6U

/**
 * @macro
 *
 * :macro:`NGTCP2_FRAME_ENCODING_ERROR` is QUIC transport error code
 * ``FRAME_ENCODING_ERROR``.
 */
#define NGTCP2_FRAME_ENCODING_ERROR 0x7U

/**
 * @macro
 *
 * :macro:`NGTCP2_TRANSPORT_PARAMETER_ERROR` is QUIC transport error
 * code ``TRANSPORT_PARAMETER_ERROR``.
 */
#define NGTCP2_TRANSPORT_PARAMETER_ERROR 0x8U

/**
 * @macro
 *
 * :macro:`NGTCP2_CONNECTION_ID_LIMIT_ERROR` is QUIC transport error
 * code ``CONNECTION_ID_LIMIT_ERROR``.
 */
#define NGTCP2_CONNECTION_ID_LIMIT_ERROR 0x9U

/**
 * @macro
 *
 * :macro:`NGTCP2_PROTOCOL_VIOLATION` is QUIC transport error code
 * ``PROTOCOL_VIOLATION``.
 */
#define NGTCP2_PROTOCOL_VIOLATION 0xAU

/**
 * @macro
 *
 * :macro:`NGTCP2_INVALID_TOKEN` is QUIC transport error code
 * ``INVALID_TOKEN``.
 */
#define NGTCP2_INVALID_TOKEN 0xBU

/**
 * @macro
 *
 * :macro:`NGTCP2_APPLICATION_ERROR` is QUIC transport error code
 * ``APPLICATION_ERROR``.
 */
#define NGTCP2_APPLICATION_ERROR 0xCU

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_BUFFER_EXCEEDED` is QUIC transport error code
 * ``CRYPTO_BUFFER_EXCEEDED``.
 */
#define NGTCP2_CRYPTO_BUFFER_EXCEEDED 0xDU

/**
 * @macro
 *
 * :macro:`NGTCP2_KEY_UPDATE_ERROR` is QUIC transport error code
 * ``KEY_UPDATE_ERROR``.
 */
#define NGTCP2_KEY_UPDATE_ERROR 0xEU

/**
 * @macro
 *
 * :macro:`NGTCP2_AEAD_LIMIT_REACHED` is QUIC transport error code
 * ``AEAD_LIMIT_REACHED``.
 */
#define NGTCP2_AEAD_LIMIT_REACHED 0xFU

/**
 * @macro
 *
 * :macro:`NGTCP2_NO_VIABLE_PATH` is QUIC transport error code
 * ``NO_VIABLE_PATH``.
 */
#define NGTCP2_NO_VIABLE_PATH 0x10U

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_ERROR` is QUIC transport error code
 * ``CRYPTO_ERROR``.
 */
#define NGTCP2_CRYPTO_ERROR 0x100U

/**
 * @macro
 *
 * :macro:`NGTCP2_VERSION_NEGOTIATION_ERROR` is QUIC transport error
 * code ``VERSION_NEGOTIATION_ERROR``.  See :rfc:`9368`.
 */
#define NGTCP2_VERSION_NEGOTIATION_ERROR 0x11

/**
 * @enum
 *
 * :type:`ngtcp2_path_validation_result` defines path validation
 * result code.
 */
typedef enum ngtcp2_path_validation_result {
  /**
   * :enum:`NGTCP2_PATH_VALIDATION_RESULT_SUCCESS` indicates
   * successful validation.
   */
  NGTCP2_PATH_VALIDATION_RESULT_SUCCESS,
  /**
   * :enum:`NGTCP2_PATH_VALIDATION_RESULT_FAILURE` indicates
   * validation failure.
   */
  NGTCP2_PATH_VALIDATION_RESULT_FAILURE,
  /**
   * :enum:`NGTCP2_PATH_VALIDATION_RESULT_ABORTED` indicates that path
   * validation was aborted.
   */
  NGTCP2_PATH_VALIDATION_RESULT_ABORTED
} ngtcp2_path_validation_result;

/**
 * @typedef
 *
 * :type:`ngtcp2_tstamp` is a timestamp with nanosecond resolution.
 * ``UINT64_MAX`` is an invalid value, and it is often used to
 * indicate that no value is set.
 */
typedef uint64_t ngtcp2_tstamp;

/**
 * @typedef
 *
 * :type:`ngtcp2_duration` is a period of time in nanosecond
 * resolution.  ``UINT64_MAX`` is an invalid value, and it is often
 * used to indicate that no value is set.
 */
typedef uint64_t ngtcp2_duration;

/**
 * @struct
 *
 * :type:`ngtcp2_cid` holds a Connection ID.
 */
typedef struct ngtcp2_cid {
  /**
   * :member:`datalen` is the length of Connection ID.
   */
  size_t datalen;
  /**
   * :member:`data` is the buffer to store Connection ID.
   */
  uint8_t data[NGTCP2_MAX_CIDLEN];
} ngtcp2_cid;

/**
 * @struct
 *
 * :type:`ngtcp2_vec` is struct iovec compatible structure to
 * reference arbitrary array of bytes.
 */
typedef struct ngtcp2_vec {
  /**
   * :member:`base` points to the data.
   */
  uint8_t *base;
  /**
   * :member:`len` is the number of bytes which the buffer pointed by
   * base contains.
   */
  size_t len;
} ngtcp2_vec;

/**
 * @function
 *
 * `ngtcp2_cid_init` initializes Connection ID |cid| with the byte
 * string pointed by |data| and its length is |datalen|.  |datalen|
 * must be at most :macro:`NGTCP2_MAX_CIDLEN`.
 */
NGTCP2_EXTERN void ngtcp2_cid_init(ngtcp2_cid *cid, const uint8_t *data,
                                   size_t datalen);

/**
 * @function
 *
 * `ngtcp2_cid_eq` returns nonzero if |a| and |b| share the same
 * Connection ID.
 */
NGTCP2_EXTERN int ngtcp2_cid_eq(const ngtcp2_cid *a, const ngtcp2_cid *b);

/**
 * @struct
 *
 * :type:`ngtcp2_pkt_hd` represents QUIC packet header.
 */
typedef struct ngtcp2_pkt_hd {
  /**
   * :member:`dcid` is Destination Connection ID.
   */
  ngtcp2_cid dcid;
  /**
   * :member:`scid` is Source Connection ID.
   */
  ngtcp2_cid scid;
  /**
   * :member:`pkt_num` is a packet number.
   */
  int64_t pkt_num;
  /**
   * :member:`token` contains token.  Only Initial packet may contain
   * token.  NULL if no token is present.
   */
  const uint8_t *token;
  /**
   * :member:`tokenlen` is the length of :member:`token`.  0 if no
   * token is present.
   */
  size_t tokenlen;
  /**
   * :member:`pkt_numlen` is the number of bytes spent to encode
   * :member:`pkt_num`.
   */
  size_t pkt_numlen;
  /**
   * :member:`len` is the sum of :member:`pkt_numlen` and the length
   * of QUIC packet payload.
   */
  size_t len;
  /**
   * :member:`version` is QUIC version.
   */
  uint32_t version;
  /**
   * :member:`type` is a type of QUIC packet.  This field does not
   * have a QUIC packet type defined for a specific QUIC version.
   * Instead, it contains version independent packet type defined by
   * this library.  See :type:`ngtcp2_pkt_type`.
   */
  uint8_t type;
  /**
   * :member:`flags` is zero or more of :macro:`NGTCP2_PKT_FLAG_*
   * <NGTCP2_PKT_FLAG_NONE>`.
   */
  uint8_t flags;
} ngtcp2_pkt_hd;

/**
 * @struct
 *
 * :type:`ngtcp2_pkt_stateless_reset` represents Stateless Reset.
 *
 * Deprecated since v1.22.0.  Use :type:`ngtcp2_pkt_stateless_reset2`
 * instead.
 */
typedef struct ngtcp2_pkt_stateless_reset {
  /**
   * :member:`stateless_reset_token` contains stateless reset token.
   */
  uint8_t stateless_reset_token[NGTCP2_STATELESS_RESET_TOKENLEN];
  /**
   * :member:`rand` points a buffer which contains random bytes
   * section.
   */
  const uint8_t *rand;
  /**
   * :member:`randlen` is the number of random bytes.
   */
  size_t randlen;
} ngtcp2_pkt_stateless_reset;

/**
 * @struct
 *
 * :type:`ngtcp2_stateless_reset_token` stores stateless reset token.
 *
 * This struct has been available since v1.22.0.
 */
typedef struct ngtcp2_stateless_reset_token {
  uint8_t data[NGTCP2_STATELESS_RESET_TOKENLEN];
} ngtcp2_stateless_reset_token;

/**
 * @struct
 *
 * :type:`ngtcp2_pkt_stateless_reset2` represents Stateless Reset.
 *
 * This struct has been available since v1.22.0.
 */
typedef struct ngtcp2_pkt_stateless_reset2 {
  /**
   * :member:`token` contains stateless reset token.
   */
  ngtcp2_stateless_reset_token token;
  /**
   * :member:`rand` points a buffer which contains random bytes
   * section.
   */
  const uint8_t *rand;
  /**
   * :member:`randlen` is the number of random bytes.
   */
  size_t randlen;
} ngtcp2_pkt_stateless_reset2;

/**
 * @macrosection
 *
 * QUIC transport parameters related macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE` is the default
 * value of max_udp_payload_size transport parameter.
 */
#define NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE 65527

/**
 * @macro
 *
 * :macro:`NGTCP2_DEFAULT_ACK_DELAY_EXPONENT` is a default value of
 * scaling factor of ACK Delay field in ACK frame.
 */
#define NGTCP2_DEFAULT_ACK_DELAY_EXPONENT 3

/**
 * @macro
 *
 * :macro:`NGTCP2_DEFAULT_MAX_ACK_DELAY` is a default value of the
 * maximum amount of time in nanoseconds by which endpoint delays
 * sending acknowledgement.
 */
#define NGTCP2_DEFAULT_MAX_ACK_DELAY (25 * NGTCP2_MILLISECONDS)

/**
 * @macro
 *
 * :macro:`NGTCP2_DEFAULT_ACTIVE_CONNECTION_ID_LIMIT` is the default
 * value of active_connection_id_limit transport parameter value if
 * omitted.
 */
#define NGTCP2_DEFAULT_ACTIVE_CONNECTION_ID_LIMIT 2

/**
 * @macro
 *
 * :macro:`NGTCP2_TLSEXT_QUIC_TRANSPORT_PARAMETERS_V1` is TLS
 * extension type of quic_transport_parameters.
 */
#define NGTCP2_TLSEXT_QUIC_TRANSPORT_PARAMETERS_V1 0x39U

#ifdef NGTCP2_USE_GENERIC_SOCKADDR
#  ifndef NGTCP2_AF_INET
#    error NGTCP2_AF_INET must be defined
#  endif /* !defined(NGTCP2_AF_INET) */

#  ifndef NGTCP2_AF_INET6
#    error NGTCP2_AF_INET6 must be defined
#  endif /* !defined(NGTCP2_AF_INET6) */

typedef unsigned short int ngtcp2_sa_family;
typedef uint16_t ngtcp2_in_port;

typedef struct ngtcp2_sockaddr {
  ngtcp2_sa_family sa_family;
  uint8_t sa_data[14];
} ngtcp2_sockaddr;

typedef struct ngtcp2_in_addr {
  uint32_t s_addr;
} ngtcp2_in_addr;

typedef struct ngtcp2_sockaddr_in {
  ngtcp2_sa_family sin_family;
  ngtcp2_in_port sin_port;
  ngtcp2_in_addr sin_addr;
  uint8_t sin_zero[8];
} ngtcp2_sockaddr_in;

typedef struct ngtcp2_in6_addr {
  uint8_t s6_addr[16];
} ngtcp2_in6_addr;

typedef struct ngtcp2_sockaddr_in6 {
  ngtcp2_sa_family sin6_family;
  ngtcp2_in_port sin6_port;
  uint32_t sin6_flowinfo;
  ngtcp2_in6_addr sin6_addr;
  uint32_t sin6_scope_id;
} ngtcp2_sockaddr_in6;

typedef uint32_t ngtcp2_socklen;
#else /* !defined(NGTCP2_USE_GENERIC_SOCKADDR) */
#  define NGTCP2_AF_INET AF_INET
#  define NGTCP2_AF_INET6 AF_INET6

/**
 * @typedef
 *
 * :type:`ngtcp2_sockaddr` is typedefed to struct sockaddr.  If
 * :macro:`NGTCP2_USE_GENERIC_SOCKADDR` is defined, it is typedefed to
 * the generic struct sockaddr defined in ngtcp2.h.
 */
typedef struct sockaddr ngtcp2_sockaddr;
/**
 * @typedef
 *
 * :type:`ngtcp2_sockaddr_in` is typedefed to struct sockaddr_in.  If
 * :macro:`NGTCP2_USE_GENERIC_SOCKADDR` is defined, it is typedefed to
 * the generic struct sockaddr_in defined in ngtcp2.h.
 */
typedef struct sockaddr_in ngtcp2_sockaddr_in;
/**
 * @typedef
 *
 * :type:`ngtcp2_sockaddr_in6` is typedefed to struct sockaddr_in6.
 * If :macro:`NGTCP2_USE_GENERIC_SOCKADDR` is defined, it is typedefed
 * to the generic struct sockaddr_in6 defined in ngtcp2.h.
 */
typedef struct sockaddr_in6 ngtcp2_sockaddr_in6;
/**
 * @typedef
 *
 * :type:`ngtcp2_socklen` is typedefed to socklen_t.  If
 * :macro:`NGTCP2_USE_GENERIC_SOCKADDR` is defined, it is typedefed to
 * uint32_t.
 */
typedef socklen_t ngtcp2_socklen;
#endif /* !defined(NGTCP2_USE_GENERIC_SOCKADDR) */

/**
 * @struct
 *
 * :type:`ngtcp2_sockaddr_union` conveniently includes all supported
 * address types.
 */
typedef union ngtcp2_sockaddr_union {
  ngtcp2_sockaddr sa;
  ngtcp2_sockaddr_in in;
  ngtcp2_sockaddr_in6 in6;
} ngtcp2_sockaddr_union;

/**
 * @struct
 *
 * :type:`ngtcp2_preferred_addr` represents preferred address
 * structure.
 */
typedef struct ngtcp2_preferred_addr {
  /**
   * :member:`cid` is a Connection ID.
   */
  ngtcp2_cid cid;
  /**
   * :member:`ipv4` contains IPv4 address and port.
   */
  ngtcp2_sockaddr_in ipv4;
  /**
   * :member:`ipv6` contains IPv6 address and port.
   */
  ngtcp2_sockaddr_in6 ipv6;
  /**
   * :member:`ipv4_present` indicates that :member:`ipv4` contains
   * IPv4 address and port.
   */
  uint8_t ipv4_present;
  /**
   * :member:`ipv6_present` indicates that :member:`ipv6` contains
   * IPv6 address and port.
   */
  uint8_t ipv6_present;
  /**
   * :member:`stateless_reset_token` contains stateless reset token.
   */
  uint8_t stateless_reset_token[NGTCP2_STATELESS_RESET_TOKENLEN];
} ngtcp2_preferred_addr;

/**
 * @struct
 *
 * :type:`ngtcp2_version_info` represents version_information
 * structure.  See :rfc:`9368`.
 */
typedef struct ngtcp2_version_info {
  /**
   * :member:`chosen_version` is the version chosen by the sender.
   */
  uint32_t chosen_version;
  /**
   * :member:`available_versions` points the wire image of
   * available_versions field.  The each version is therefore in
   * network byte order.
   */
  const uint8_t *available_versions;
  /**
   * :member:`available_versionslen` is the number of bytes pointed by
   * :member:`available_versions`, not the number of versions
   * included.
   */
  size_t available_versionslen;
} ngtcp2_version_info;

#define NGTCP2_TRANSPORT_PARAMS_V1 1
#define NGTCP2_TRANSPORT_PARAMS_VERSION NGTCP2_TRANSPORT_PARAMS_V1

/**
 * @struct
 *
 * :type:`ngtcp2_transport_params` represents QUIC transport
 * parameters.
 */
typedef struct ngtcp2_transport_params {
  /**
   * :member:`preferred_addr` contains preferred address if
   * :member:`preferred_addr_present` is nonzero.
   */
  ngtcp2_preferred_addr preferred_addr;
  /**
   * :member:`original_dcid` is the Destination Connection ID field
   * from the first Initial packet from client.  Server must specify
   * this field and set :member:`original_dcid_present` to nonzero.
   * It is expected that application knows the original Destination
   * Connection ID even if it sends Retry packet, for example, by
   * including it in retry token.  Otherwise, application should not
   * specify this field.
   */
  ngtcp2_cid original_dcid;
  /**
   * :member:`initial_scid` is the Source Connection ID field from the
   * first Initial packet the local endpoint sends.  Application
   * should not specify this field.  If :member:`initial_scid_present`
   * is set to nonzero, it indicates this field is set.
   */
  ngtcp2_cid initial_scid;
  /**
   * :member:`retry_scid` is the Source Connection ID field from Retry
   * packet.  Only server uses this field.  If server application
   * received Initial packet with retry token from client, and server
   * successfully verified its token, server application must set
   * Destination Connection ID field from the Initial packet to this
   * field, and set :member:`retry_scid_present` to nonzero.  Server
   * application must verify that the Destination Connection ID from
   * Initial packet was sent in Retry packet by, for example,
   * including the Connection ID in a token, or including it in AAD
   * when encrypting a token.
   */
  ngtcp2_cid retry_scid;
  /**
   * :member:`initial_max_stream_data_bidi_local` is the size of flow
   * control window of locally initiated stream.  This is the number
   * of bytes that the remote endpoint can send, and the local
   * endpoint must ensure that it has enough buffer to receive them.
   */
  uint64_t initial_max_stream_data_bidi_local;
  /**
   * :member:`initial_max_stream_data_bidi_remote` is the size of flow
   * control window of remotely initiated stream.  This is the number
   * of bytes that the remote endpoint can send, and the local
   * endpoint must ensure that it has enough buffer to receive them.
   */
  uint64_t initial_max_stream_data_bidi_remote;
  /**
   * :member:`initial_max_stream_data_uni` is the size of flow control
   * window of remotely initiated unidirectional stream.  This is the
   * number of bytes that the remote endpoint can send, and the local
   * endpoint must ensure that it has enough buffer to receive them.
   */
  uint64_t initial_max_stream_data_uni;
  /**
   * :member:`initial_max_data` is the connection level flow control
   * window.
   */
  uint64_t initial_max_data;
  /**
   * :member:`initial_max_streams_bidi` is the number of concurrent
   * streams that the remote endpoint can create.
   */
  uint64_t initial_max_streams_bidi;
  /**
   * :member:`initial_max_streams_uni` is the number of concurrent
   * unidirectional streams that the remote endpoint can create.
   */
  uint64_t initial_max_streams_uni;
  /**
   * :member:`max_idle_timeout` is a duration during which sender
   * allows quiescent.  0 means no idle timeout.  It must not be
   * UINT64_MAX.
   */
  ngtcp2_duration max_idle_timeout;
  /**
   * :member:`max_udp_payload_size` is the maximum UDP payload size
   * that the local endpoint can receive.
   */
  uint64_t max_udp_payload_size;
  /**
   * :member:`active_connection_id_limit` is the maximum number of
   * Connection ID that sender can store.  If specified, it must be in
   * the range of [:macro:`NGTCP2_DEFAULT_ACTIVE_CONNECTION_ID_LIMIT`,
   * 8], inclusive.
   */
  uint64_t active_connection_id_limit;
  /**
   * :member:`ack_delay_exponent` is the exponent used in ACK Delay
   * field in ACK frame.
   */
  uint64_t ack_delay_exponent;
  /**
   * :member:`max_ack_delay` is the maximum acknowledgement delay by
   * which the local endpoint will delay sending acknowledgements.  It
   * must be strictly less than (1 << 14) milliseconds.
   * Sub-millisecond part is dropped when sending it in a QUIC
   * transport parameter.
   */
  ngtcp2_duration max_ack_delay;
  /**
   * :member:`max_datagram_frame_size` is the maximum size of DATAGRAM
   * frame that the local endpoint willingly receives.  Specifying 0
   * disables DATAGRAM support.  See :rfc:`9221`.
   */
  uint64_t max_datagram_frame_size;
  /**
   * :member:`stateless_reset_token_present` is nonzero if
   * :member:`stateless_reset_token` field is set.
   */
  uint8_t stateless_reset_token_present;
  /**
   * :member:`disable_active_migration` is nonzero if the local
   * endpoint does not support active connection migration.
   */
  uint8_t disable_active_migration;
  /**
   * :member:`original_dcid_present` is nonzero if
   * :member:`original_dcid` field is set.
   */
  uint8_t original_dcid_present;
  /**
   * :member:`initial_scid_present` is nonzero if
   * :member:`initial_scid` field is set.
   */
  uint8_t initial_scid_present;
  /**
   * :member:`retry_scid_present` is nonzero if :member:`retry_scid`
   * field is set.
   */
  uint8_t retry_scid_present;
  /**
   * :member:`preferred_addr_present` is nonzero if
   * :member:`preferred_address` is set.
   */
  uint8_t preferred_addr_present;
  /**
   * :member:`stateless_reset_token` contains stateless reset token.
   */
  uint8_t stateless_reset_token[NGTCP2_STATELESS_RESET_TOKENLEN];
  /**
   * :member:`grease_quic_bit` is nonzero if sender supports "Greasing
   * the QUIC Bit" extension.  See :rfc:`9287`.
   */
  uint8_t grease_quic_bit;
  /**
   * :member:`version_info` contains version_information field if
   * :member:`version_info_present` is nonzero.  Application should
   * not specify this field.
   */
  ngtcp2_version_info version_info;
  /**
   * :member:`version_info_present` is nonzero if
   * :member:`version_info` is set.  Application should not specify
   * this field.
   */
  uint8_t version_info_present;
} ngtcp2_transport_params;

#define NGTCP2_CONN_INFO_V1 1
#define NGTCP2_CONN_INFO_V2 2
#define NGTCP2_CONN_INFO_VERSION NGTCP2_CONN_INFO_V2

/**
 * @struct
 *
 * :type:`ngtcp2_conn_info` holds various connection statistics.
 */
typedef struct ngtcp2_conn_info {
  /**
   * :member:`latest_rtt` is the latest RTT sample which is not
   * adjusted by acknowledgement delay.
   */
  ngtcp2_duration latest_rtt;
  /**
   * :member:`min_rtt` is the minimum RTT seen so far.  It is not
   * adjusted by acknowledgement delay.
   */
  ngtcp2_duration min_rtt;
  /**
   * :member:`smoothed_rtt` is the smoothed RTT.
   */
  ngtcp2_duration smoothed_rtt;
  /**
   * :member:`rttvar` is a mean deviation of observed RTT.
   */
  ngtcp2_duration rttvar;
  /**
   * :member:`cwnd` is the size of congestion window.
   */
  uint64_t cwnd;
  /**
   * :member:`ssthresh` is slow start threshold.
   */
  uint64_t ssthresh;
  /**
   * :member:`bytes_in_flight` is the number in bytes of all sent
   * packets which have not been acknowledged.
   */
  uint64_t bytes_in_flight;
  /* The following fields have been added since NGTCP2_CONN_INFO_V2. */
  /**
   * :member:`pkt_sent` is the number of QUIC packets sent.  This
   * field has been available since v1.16.0.
   */
  uint64_t pkt_sent;
  /**
   * :member:`bytes_sent` is the number of bytes (the sum of QUIC
   * packet length) sent.  This field has been available since
   * v1.16.0.
   */
  uint64_t bytes_sent;
  /**
   * :member:`pkt_recv` is the number of QUIC packets received,
   * excluding discarded ones.  This field has been available since
   * v1.16.0.
   */
  uint64_t pkt_recv;
  /**
   * :member:`bytes_recv` is the number of bytes (the sum of QUIC
   * packet length) received, excluding discarded ones.  This field
   * has been available since v1.16.0.
   */
  uint64_t bytes_recv;
  /**
   * :member:`pkt_lost` is the number of QUIC packets that are
   * considered lost, excluding PMTUD packets.  This field has been
   * available since v1.16.0.
   */
  uint64_t pkt_lost;
  /**
   * :member:`bytes_lost` is the number of bytes (the sum of QUIC
   * packet length) lost, excluding PMTUD packets.  This field has
   * been available since v1.16.0.
   */
  uint64_t bytes_lost;
  /**
   * :member:`ping_recv` is the number of PING frames received.  This
   * field has been available since v1.16.0.
   */
  uint64_t ping_recv;
  /**
   * :member:`pkt_discarded` is the number of QUIC packets discarded.
   * This field has been available since v1.16.0.
   */
  uint64_t pkt_discarded;
} ngtcp2_conn_info;

/**
 * @enum
 *
 * :type:`ngtcp2_cc_algo` defines congestion control algorithms.
 */
typedef enum ngtcp2_cc_algo {
  /**
   * :enum:`NGTCP2_CC_ALGO_RENO` represents Reno.
   */
  NGTCP2_CC_ALGO_RENO = 0x00,
  /**
   * :enum:`NGTCP2_CC_ALGO_CUBIC` represents Cubic.
   */
  NGTCP2_CC_ALGO_CUBIC = 0x01,
  /**
   * :enum:`NGTCP2_CC_ALGO_BBR` represents BBR v2.
   */
  NGTCP2_CC_ALGO_BBR = 0x02
} ngtcp2_cc_algo;

/**
 * @functypedef
 *
 * :type:`ngtcp2_printf` is a callback function for logging.
 * |user_data| is the same object passed to `ngtcp2_conn_client_new`
 * or `ngtcp2_conn_server_new`.
 */
typedef void (*ngtcp2_printf)(void *user_data, const char *format, ...);

/**
 * @macrosection
 *
 * QLog related macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_QLOG_WRITE_FLAG_NONE` indicates no flag set.
 */
#define NGTCP2_QLOG_WRITE_FLAG_NONE 0x00U
/**
 * @macro
 *
 * :macro:`NGTCP2_QLOG_WRITE_FLAG_FIN` indicates that this is the
 * final call to :type:`ngtcp2_qlog_write` in the current connection.
 */
#define NGTCP2_QLOG_WRITE_FLAG_FIN 0x01U

/**
 * @struct
 *
 * :type:`ngtcp2_rand_ctx` is a wrapper around native random number
 * generator.  It is opaque to the ngtcp2 library.  This might be
 * useful if application needs to specify random number generator per
 * thread or per connection.
 */
typedef struct ngtcp2_rand_ctx {
  /**
   * :member:`native_handle` is a pointer to an underlying random
   * number generator.
   */
  void *native_handle;
} ngtcp2_rand_ctx;

/**
 * @functypedef
 *
 * :type:`ngtcp2_qlog_write` is a callback function which is called to
 * write qlog |data| of length |datalen| bytes.  |flags| is bitwise OR
 * of zero or more of :macro:`NGTCP2_QLOG_WRITE_FLAG_*
 * <NGTCP2_QLOG_WRITE_FLAG_NONE>`.  If
 * :macro:`NGTCP2_QLOG_WRITE_FLAG_FIN` is set, |datalen| may be 0.
 */
typedef void (*ngtcp2_qlog_write)(void *user_data, uint32_t flags,
                                  const void *data, size_t datalen);

/**
 * @enum
 *
 * :type:`ngtcp2_token_type` defines the type of token.
 */
typedef enum ngtcp2_token_type {
  /**
   * :enum:`NGTCP2_TOKEN_TYPE_UNKNOWN` indicates that the type of
   * token is unknown.
   */
  NGTCP2_TOKEN_TYPE_UNKNOWN,
  /**
   * :enum:`NGTCP2_TOKEN_TYPE_RETRY` indicates that a token comes from
   * Retry packet.
   */
  NGTCP2_TOKEN_TYPE_RETRY,
  /**
   * :enum:`NGTCP2_TOKEN_TYPE_NEW_TOKEN` indicates that a token comes
   * from NEW_TOKEN frame.
   */
  NGTCP2_TOKEN_TYPE_NEW_TOKEN
} ngtcp2_token_type;

#define NGTCP2_SETTINGS_V1 1
#define NGTCP2_SETTINGS_V2 2
#define NGTCP2_SETTINGS_V3 3
#define NGTCP2_SETTINGS_VERSION NGTCP2_SETTINGS_V3

/**
 * @struct
 *
 * :type:`ngtcp2_settings` defines QUIC connection settings.
 */
typedef struct ngtcp2_settings {
  /**
   * :member:`qlog_write` is a callback function to write qlog.
   * Setting ``NULL`` disables qlog.
   */
  ngtcp2_qlog_write qlog_write;
  /**
   * :member:`cc_algo` specifies congestion control algorithm.
   */
  ngtcp2_cc_algo cc_algo;
  /**
   * :member:`initial_ts` is an initial timestamp given to the
   * library.
   */
  ngtcp2_tstamp initial_ts;
  /**
   * :member:`initial_rtt` is an initial RTT.
   */
  ngtcp2_duration initial_rtt;
  /**
   * :member:`log_printf` is a function that the library uses to write
   * logs.  ``NULL`` means no logging output.  It is nothing to do
   * with qlog.
   */
  ngtcp2_printf log_printf;
  /**
   * :member:`max_tx_udp_payload_size` is the maximum size of UDP
   * datagram payload that the local endpoint transmits.  This must be
   * larger than or equal to :macro:`NGTCP2_MAX_UDP_PAYLOAD_SIZE`, and
   * less then or equal to :macro:`NGTCP2_MAX_TX_UDP_PAYLOAD_SIZE`.
   */
  size_t max_tx_udp_payload_size;
  /**
   * :member:`token` is a token from Retry packet or NEW_TOKEN frame.
   *
   * Server sets this field if it received the token in Client Initial
   * packet and successfully validated.  It should also set
   * :member:`token_type` field.
   *
   * Client sets this field if it intends to send token in its Initial
   * packet.
   *
   * `ngtcp2_conn_server_new` and `ngtcp2_conn_client_new` make a copy
   * of token.
   *
   * Set NULL if there is no token.
   */
  const uint8_t *token;
  /**
   * :member:`tokenlen` is the length of :member:`token`.  Set 0 if
   * there is no token.
   */
  size_t tokenlen;
  /**
   * :member:`token_type` is the type of token.  Server application
   * should set this field.
   */
  ngtcp2_token_type token_type;
  /**
   * :member:`rand_ctx` is an optional random number generator to be
   * passed to :type:`ngtcp2_rand` callback.
   */
  ngtcp2_rand_ctx rand_ctx;
  /**
   * :member:`max_window` is the maximum connection-level flow control
   * window if connection-level window auto-tuning is enabled.  The
   * connection-level window auto tuning is enabled if nonzero value
   * is specified in this field.  The initial value of window size is
   * :member:`ngtcp2_transport_params.initial_max_data`.  The window
   * size is scaled up to the value specified in this field.
   */
  uint64_t max_window;
  /**
   * :member:`max_stream_window` is the maximum stream-level flow
   * control window if stream-level window auto-tuning is enabled.
   * The stream-level window auto-tuning is enabled if nonzero value
   * is specified in this field.  The initial value of window size is
   * :member:`ngtcp2_transport_params.initial_max_stream_data_bidi_remote`,
   * :member:`ngtcp2_transport_params.initial_max_stream_data_bidi_local`,
   * or :member:`ngtcp2_transport_params.initial_max_stream_data_uni`,
   * depending on the type of stream.  The window size is scaled up to
   * the value specified in this field.
   *
   * Please note that the auto-tuning is done per stream.  Even if the
   * previous stream gets larger window as a result of auto-tuning,
   * the new stream still starts with the initial value set in
   * transport parameters.  This might become a bottleneck if
   * congestion window of a remote server is wide open.  If this
   * causes an issue, do not enable auto-tuning.
   */
  uint64_t max_stream_window;
  /**
   * :member:`ack_thresh` is the minimum number of the received ACK
   * eliciting packets that triggers the immediate acknowledgement
   * from the local endpoint.
   */
  size_t ack_thresh;
  /**
   * :member:`no_tx_udp_payload_size_shaping`, if set to nonzero,
   * instructs the library not to limit the UDP payload size to
   * :macro:`NGTCP2_MAX_UDP_PAYLOAD_SIZE` (which can be extended by
   * Path MTU Discovery), and instead use the minimum size among the
   * given buffer size, :member:`max_tx_udp_payload_size`, and the
   * received max_udp_payload_size QUIC transport parameter.
   */
  uint8_t no_tx_udp_payload_size_shaping;
  /**
   * :member:`handshake_timeout` is the period of time before giving
   * up QUIC connection establishment.  If QUIC handshake is not
   * complete within this period, `ngtcp2_conn_handle_expiry` returns
   * :macro:`NGTCP2_ERR_HANDSHAKE_TIMEOUT` error.  The deadline is
   * :member:`initial_ts` + :member:`handshake_timeout`.  If this
   * field is set to ``UINT64_MAX``, no handshake timeout is set.
   */
  ngtcp2_duration handshake_timeout;
  /**
   * :member:`preferred_versions` is the array of versions that are
   * preferred by the local endpoint.  All versions set in this array
   * must be supported by the library, and compatible to QUIC v1.  The
   * reserved versions are not allowed.  They are sorted in the order
   * of preference.
   *
   * On compatible version negotiation, server will negotiate one of
   * those versions contained in this array if there is some overlap
   * between these versions and the versions offered by the client.
   * If there is no overlap, but the client chosen version is
   * supported by the library, the server chooses the client chosen
   * version as the negotiated version.  This version set corresponds
   * to Offered Versions described in :rfc:`9368`, and it should be
   * included in Version Negotiation packet.
   *
   * Client uses this field and :member:`original_version` to prevent
   * version downgrade attack if it reacted upon Version Negotiation
   * packet.  If this field is specified, client must include
   * |client_chosen_version| passed to `ngtcp2_conn_client_new` unless
   * |client_chosen_version| is a reserved version.
   */
  const uint32_t *preferred_versions;
  /**
   * :member:`preferred_versionslen` is the number of versions that
   * are contained in the array pointed by
   * :member:`preferred_versions`.
   */
  size_t preferred_versionslen;
  /**
   * :member:`available_versions` is the array of versions that are
   * going to be set in :member:`available_versions
   * <ngtcp2_version_info.available_versions>` field of outgoing
   * version_information QUIC transport parameter.
   *
   * For server, this corresponds to Fully-Deployed Versions described
   * in :rfc:`9368`.  If this field is not set, it is set to
   * :member:`preferred_versions` internally if
   * :member:`preferred_versionslen` is not zero.  If this field is
   * not set, and :member:`preferred_versionslen` is zero, this field
   * is set to :macro:`NGTCP2_PROTO_VER_V1` internally.
   *
   * Client must include |client_chosen_version| passed to
   * `ngtcp2_conn_client_new` in this array if this field is set and
   * |client_chosen_version| is not a reserved version.  If this field
   * is not set, |client_chosen_version| passed to
   * `ngtcp2_conn_client_new` will be set in this field internally
   * unless |client_chosen_version| is a reserved version.
   */
  const uint32_t *available_versions;
  /**
   * :member:`available_versionslen` is the number of versions that
   * are contained in the array pointed by
   * :member:`available_versions`.
   */
  size_t available_versionslen;
  /**
   * :member:`original_version` is the original version that client
   * initially used to make a connection attempt.  If it is set, and
   * it differs from |client_chosen_version| passed to
   * `ngtcp2_conn_client_new`, the library assumes that client reacted
   * upon Version Negotiation packet.  Server does not use this field.
   */
  uint32_t original_version;
  /**
   * :member:`no_pmtud`, if set to nonzero, disables Path MTU
   * Discovery.
   */
  uint8_t no_pmtud;
  /**
   * :member:`initial_pkt_num` is the initial packet number for each
   * packet number space.  It must be in range [0, INT32_MAX],
   * inclusive.
   */
  uint32_t initial_pkt_num;
  /* The following fields have been added since NGTCP2_SETTINGS_V2. */
  /**
   * :member:`pmtud_probes` is the array of UDP datagram payload size
   * to probe during Path MTU Discovery.  The discovery is done in the
   * order appeared in this array.  The payload size must be strictly
   * larger than :macro:`NGTCP2_MAX_UDP_PAYLOAD_SIZE`, and less than
   * or equal to :macro:`NGTCP2_MAX_TX_UDP_PAYLOAD_SIZE`.  Otherwise
   * the behavior is undefined.  The maximum value in this array
   * should be set to :member:`max_tx_udp_payload_size`.  If this
   * field is not set, the predefined PMTUD probes are made.  This
   * field has been available since v1.4.0.
   */
  const uint16_t *pmtud_probes;
  /**
   * :member:`pmtud_probeslen` is the number of elements that are
   * contained in the array pointed by :member:`pmtud_probes`.  This
   * field has been available since v1.4.0.
   */
  size_t pmtud_probeslen;
  /* The following fields have been added since NGTCP2_SETTINGS_V3. */
  /**
   * :member:`glitch_ratelim_burst` is the maximum number of tokens
   * available to "glitch" rate limiter.  "glitch" is a suspicious
   * activity from a remote endpoint.  If detected, certain amount of
   * tokens are consumed.  If no tokens are available to consume, the
   * connection is closed.  The rate of token generation is specified
   * by :member:`glitch_ratelim_rate`.  This field has been available
   * since v1.15.0.
   */
  uint64_t glitch_ratelim_burst;
  /**
   * :member:`glitch_ratelim_rate` is the number of tokens generated
   * per second.  See :member:`glitch_ratelim_burst` for "glitch" rate
   * limiter.  This field has been available since v1.15.0.
   */
  uint64_t glitch_ratelim_rate;
} ngtcp2_settings;

/**
 * @struct
 *
 * :type:`ngtcp2_addr` is the endpoint address.
 */
typedef struct ngtcp2_addr {
  /**
   * :member:`addr` points to the buffer which contains endpoint
   * address.  It must not be ``NULL``.
   */
  ngtcp2_sockaddr *addr;
  /**
   * :member:`addrlen` is the length of :member:`addr`.  It must not
   * be longer than sizeof(:type:`ngtcp2_sockaddr_union`).
   */
  ngtcp2_socklen addrlen;
} ngtcp2_addr;

/**
 * @struct
 *
 * :type:`ngtcp2_path` is the network endpoints where a packet is sent
 * and received.
 */
typedef struct ngtcp2_path {
  /**
   * :member:`local` is the address of local endpoint.
   */
  ngtcp2_addr local;
  /**
   * :member:`remote` is the address of remote endpoint.
   */
  ngtcp2_addr remote;
  /**
   * :member:`user_data` is an arbitrary data and opaque to the
   * library.
   *
   * Note that :type:`ngtcp2_path` is generally passed to
   * :type:`ngtcp2_conn` by an application, and :type:`ngtcp2_conn`
   * stores their copies.  Unfortunately, there is no way for the
   * application to know when :type:`ngtcp2_conn` finished using a
   * specific :type:`ngtcp2_path` object in mid connection, which
   * means that the application cannot free the data pointed by this
   * field.  Therefore, it is advised to use this field only when the
   * data pointed by this field persists in an entire lifetime of the
   * connection.
   */
  void *user_data;
} ngtcp2_path;

/**
 * @struct
 *
 * :type:`ngtcp2_path_storage` is a convenient struct to have buffers
 * to store the longest addresses.
 */
typedef struct ngtcp2_path_storage {
  /**
   * :member:`path` stores network path.
   */
  ngtcp2_path path;
  /**
   * :member:`local_addrbuf` is a buffer to store local address.
   */
  ngtcp2_sockaddr_union local_addrbuf;
  /**
   * :member:`remote_addrbuf` is a buffer to store remote address.
   */
  ngtcp2_sockaddr_union remote_addrbuf;
} ngtcp2_path_storage;

/**
 * @struct
 *
 * :type:`ngtcp2_crypto_md` is a wrapper around native message digest
 * object.
 */
typedef struct ngtcp2_crypto_md {
  /**
   * :member:`native_handle` is a pointer to an underlying message
   * digest object.
   */
  void *native_handle;
} ngtcp2_crypto_md;

/**
 * @struct
 *
 * :type:`ngtcp2_crypto_aead` is a wrapper around native AEAD object.
 */
typedef struct ngtcp2_crypto_aead {
  /**
   * :member:`native_handle` is a pointer to an underlying AEAD
   * object.
   */
  void *native_handle;
  /**
   * :member:`max_overhead` is the number of additional bytes which
   * AEAD encryption needs on encryption.
   */
  size_t max_overhead;
} ngtcp2_crypto_aead;

/**
 * @struct
 *
 * :type:`ngtcp2_crypto_cipher` is a wrapper around native cipher
 * object.
 */
typedef struct ngtcp2_crypto_cipher {
  /**
   * :member:`native_handle` is a pointer to an underlying cipher
   * object.
   */
  void *native_handle;
} ngtcp2_crypto_cipher;

/**
 * @struct
 *
 * :type:`ngtcp2_crypto_aead_ctx` is a wrapper around native AEAD
 * cipher context object.  It should be initialized with a specific
 * key.  ngtcp2 library reuses this context object to encrypt or
 * decrypt multiple packets.
 */
typedef struct ngtcp2_crypto_aead_ctx {
  /**
   * :member:`native_handle` is a pointer to an underlying AEAD
   * context object.
   */
  void *native_handle;
} ngtcp2_crypto_aead_ctx;

/**
 * @struct
 *
 * :type:`ngtcp2_crypto_cipher_ctx` is a wrapper around native cipher
 * context object.  It should be initialized with a specific key.
 * ngtcp2 library reuses this context object to encrypt or decrypt
 * multiple packet headers.
 */
typedef struct ngtcp2_crypto_cipher_ctx {
  /**
   * :member:`native_handle` is a pointer to an underlying cipher
   * context object.
   */
  void *native_handle;
} ngtcp2_crypto_cipher_ctx;

/**
 * @struct
 *
 * :type:`ngtcp2_crypto_ctx` is a convenient structure to bind all
 * crypto related objects in one place.  Use
 * `ngtcp2_crypto_ctx_initial` to initialize this struct for Initial
 * packet encryption.  For Handshake and 1-RTT packets, use
 * `ngtcp2_crypto_ctx_tls`.  For 0-RTT packets, use
 * `ngtcp2_crypto_ctx_tls_early`.
 */
typedef struct ngtcp2_crypto_ctx {
  /**
   * :member:`aead` is AEAD object.
   */
  ngtcp2_crypto_aead aead;
  /**
   * :member:`md` is message digest object.
   */
  ngtcp2_crypto_md md;
  /**
   * :member:`hp` is header protection cipher.
   */
  ngtcp2_crypto_cipher hp;
  /**
   * :member:`max_encryption` is the number of encryption which this
   * key can be used with.
   */
  uint64_t max_encryption;
  /**
   * :member:`max_decryption_failure` is the number of decryption
   * failure with this key.
   */
  uint64_t max_decryption_failure;
} ngtcp2_crypto_ctx;

/**
 * @function
 *
 * `ngtcp2_transport_params_encode` encodes |params| in |dest| of
 * length |destlen|.
 *
 * If |dest| is NULL, and |destlen| is zero, this function just
 * returns the number of bytes required to store the encoded transport
 * parameters.
 *
 * This function returns the number of bytes written, or one of the
 * following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_transport_params_encode_versioned(
  uint8_t *dest, size_t destlen, int transport_params_version,
  const ngtcp2_transport_params *params);

/**
 * @function
 *
 * `ngtcp2_transport_params_decode` decodes transport parameters in
 * |data| of length |datalen|, and stores the result in the object
 * pointed by |params|.
 *
 * If an optional parameter is missing, the default value is assigned.
 *
 * The following fields may point to somewhere inside the buffer
 * pointed by |data| of length |datalen|:
 *
 * - :member:`ngtcp2_transport_params.version_info.available_versions
 *   <ngtcp2_version_info.available_versions>`
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_MALFORMED_TRANSPORT_PARAM`
 *     The input is malformed.
 */
NGTCP2_EXTERN int
ngtcp2_transport_params_decode_versioned(int transport_params_version,
                                         ngtcp2_transport_params *params,
                                         const uint8_t *data, size_t datalen);

/**
 * @function
 *
 * `ngtcp2_transport_params_decode_new` decodes transport parameters
 * in |data| of length |datalen|, and stores the result in the object
 * allocated dynamically.  The pointer to the allocated object is
 * assigned to |*pparams|.  Unlike `ngtcp2_transport_params_decode`,
 * all direct and indirect fields are also allocated dynamically if
 * needed.
 *
 * |mem| is a memory allocator to allocate memory.  If |mem| is
 * ``NULL``, the memory allocator returned by `ngtcp2_mem_default()`
 * is used.
 *
 * If the optional parameters are missing, the default value is
 * assigned.
 *
 * `ngtcp2_transport_params_del` frees the memory allocated by this
 * function.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_MALFORMED_TRANSPORT_PARAM`
 *     The input is malformed.
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int
ngtcp2_transport_params_decode_new(ngtcp2_transport_params **pparams,
                                   const uint8_t *data, size_t datalen,
                                   const ngtcp2_mem *mem);

/**
 * @function
 *
 * `ngtcp2_transport_params_del` frees the |params| which must be
 * dynamically allocated by `ngtcp2_transport_params_decode_new`.
 *
 * |mem| is a memory allocator that allocated |params|.  If |mem| is
 * ``NULL``, the memory allocator returned by `ngtcp2_mem_default()`
 * is used.
 *
 * If |params| is ``NULL``, this function does nothing.
 */
NGTCP2_EXTERN void ngtcp2_transport_params_del(ngtcp2_transport_params *params,
                                               const ngtcp2_mem *mem);

/**
 * @struct
 *
 * :type:`ngtcp2_version_cid` is a convenient struct to store the
 * result of `ngtcp2_pkt_decode_version_cid`.
 */
typedef struct ngtcp2_version_cid {
  /**
   * :member:`version` stores QUIC version.
   */
  uint32_t version;
  /**
   * :member:`dcid` points to the Destination Connection ID.
   */
  const uint8_t *dcid;
  /**
   * :member:`dcidlen` is the length of the Destination Connection ID
   * pointed by :member:`dcid`.
   */
  size_t dcidlen;
  /**
   * :member:`scid` points to the Source Connection ID.
   */
  const uint8_t *scid;
  /**
   * :member:`scidlen` is the length of the Source Connection ID
   * pointed by :member:`scid`.
   */
  size_t scidlen;
} ngtcp2_version_cid;

/**
 * @function
 *
 * `ngtcp2_pkt_decode_version_cid` extracts QUIC version, Destination
 * Connection ID and Source Connection ID from the packet pointed by
 * |data| of length |datalen|.  This function can handle Connection ID
 * up to 255 bytes unlike `ngtcp2_pkt_decode_hd_long` or
 * `ngtcp2_pkt_decode_hd_short` which are only capable of handling
 * Connection ID less than or equal to :macro:`NGTCP2_MAX_CIDLEN`.
 * Longer Connection ID is only valid if the version is unsupported
 * QUIC version.
 *
 * If the given packet is Long header packet, this function extracts
 * the version from the packet, and assigns it to
 * :member:`dest->version <ngtcp2_version_cid.version>`.  It also
 * extracts the pointer to the Destination Connection ID and its
 * length, and assigns them to :member:`dest->dcid
 * <ngtcp2_version_cid.dcid>` and :member:`dest->dcidlen
 * <ngtcp2_version_cid.dcidlen>` respectively.  Similarly, it extracts
 * the pointer to the Source Connection ID and its length, and assigns
 * them to :member:`dest->scid <ngtcp2_version_cid.scid>` and
 * :member:`dest->scidlen <ngtcp2_version_cid.scidlen>` respectively.
 * |short_dcidlen| is ignored.
 *
 * If the given packet is Short header packet, :member:`dest->version
 * <ngtcp2_version_cid.version>` will be 0, :member:`dest->scid
 * <ngtcp2_version_cid.scid>` will be ``NULL``, and
 * :member:`dest->scidlen <ngtcp2_version_cid.scidlen>` will be 0.
 * Because the Short header packet does not have the length of
 * Destination Connection ID, the caller has to pass the length in
 * |short_dcidlen|.  This function extracts the pointer to the
 * Destination Connection ID, and assigns it to :member:`dest->dcid
 * <ngtcp2_version_cid.dcid>`.  |short_dcidlen| is assigned to
 * :member:`dest->dcidlen <ngtcp2_version_cid.dcidlen>`.
 *
 * If Version Negotiation is required, this function returns
 * :macro:`NGTCP2_ERR_VERSION_NEGOTIATION`.  Unlike the other error
 * cases, all fields of |dest| are assigned as described above.
 *
 * This function returns 0 if it succeeds.  Otherwise, one of the
 * following negative error code:
 *
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     The function could not decode the packet header.
 * :macro:`NGTCP2_ERR_VERSION_NEGOTIATION`
 *     Version Negotiation packet should be sent.
 */
NGTCP2_EXTERN int ngtcp2_pkt_decode_version_cid(ngtcp2_version_cid *dest,
                                                const uint8_t *data,
                                                size_t datalen,
                                                size_t short_dcidlen);

/**
 * @function
 *
 * `ngtcp2_pkt_decode_hd_long` decodes QUIC long packet header in
 * |pkt| of length |pktlen|.  This function only parses the input just
 * before packet number field.
 *
 * This function does not verify that length field is correct.  In
 * other words, this function succeeds even if length > |pktlen|.
 *
 * This function can handle Connection ID up to
 * :macro:`NGTCP2_MAX_CIDLEN`.  Consider to use
 * `ngtcp2_pkt_decode_version_cid` to get longer Connection ID.
 *
 * This function handles Version Negotiation specially.  If version
 * field is 0, |pkt| must contain Version Negotiation packet.  Version
 * Negotiation packet has random type in wire format.  For
 * convenience, this function sets
 * :enum:`ngtcp2_pkt_type.NGTCP2_PKT_VERSION_NEGOTIATION` to
 * :member:`dest->type <ngtcp2_pkt_hd.type>`, clears
 * :macro:`NGTCP2_PKT_FLAG_LONG_FORM` flag from :member:`dest->flags
 * <ngtcp2_pkt_hd.flags>`, and sets 0 to :member:`dest->len
 * <ngtcp2_pkt_hd.len>`.  Version Negotiation packet occupies a single
 * packet.
 *
 * It stores the result in the object pointed by |dest|, and returns
 * the number of bytes decoded to read the packet header if it
 * succeeds, or one of the following error codes:
 *
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     Packet is too short; or it is not a long header
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_pkt_decode_hd_long(ngtcp2_pkt_hd *dest,
                                                     const uint8_t *pkt,
                                                     size_t pktlen);

/**
 * @function
 *
 * `ngtcp2_pkt_decode_hd_short` decodes QUIC short header in |pkt| of
 * length |pktlen|.  Short header packet does not encode the length of
 * Connection ID, thus we need the input from the outside.  |dcidlen|
 * is the length of Destination Connection ID in packet header.  This
 * function only parses the input just before packet number field.
 * This function can handle Connection ID up to
 * :macro:`NGTCP2_MAX_CIDLEN`.  Consider to use
 * `ngtcp2_pkt_decode_version_cid` to get longer Connection ID.  It
 * stores the result in the object pointed by |dest|, and returns the
 * number of bytes decoded to read the packet header if it succeeds,
 * or one of the following error codes:
 *
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     Packet is too short; or it is not a short header
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_pkt_decode_hd_short(ngtcp2_pkt_hd *dest,
                                                      const uint8_t *pkt,
                                                      size_t pktlen,
                                                      size_t dcidlen);

/**
 * @function
 *
 * `ngtcp2_pkt_write_stateless_reset` writes Stateless Reset packet in
 * the buffer pointed by |dest| whose length is |destlen|.
 * |stateless_reset_token| is a pointer to the Stateless Reset Token,
 * and its length must be :macro:`NGTCP2_STATELESS_RESET_TOKENLEN`
 * bytes long.  |rand| specifies the random octets preceding Stateless
 * Reset Token.  The length of |rand| is specified by |randlen| which
 * must be at least :macro:`NGTCP2_MIN_STATELESS_RESET_RANDLEN` bytes
 * long.
 *
 * If |randlen| is too long to write them all in the buffer, |rand| is
 * written to the buffer as much as possible, and is truncated.
 *
 * This function returns the number of bytes written to the buffer, or
 * one of the following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small.
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     |randlen| is strictly less than
 *     :macro:`NGTCP2_MIN_STATELESS_RESET_RANDLEN`.
 *
 * Deprecated since v1.22.0.  Use `ngtcp2_pkt_write_stateless_reset2`
 * instead.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_pkt_write_stateless_reset(
  uint8_t *dest, size_t destlen, const uint8_t *stateless_reset_token,
  const uint8_t *rand, size_t randlen);

/**
 * @function
 *
 * `ngtcp2_pkt_write_stateless_reset2` writes Stateless Reset packet
 * in the buffer pointed by |dest| whose length is |destlen|.  |token|
 * must store the Stateless Reset Token.  |rand| specifies the random
 * octets preceding Stateless Reset Token.  The length of |rand| is
 * specified by |randlen| which must be at least
 * :macro:`NGTCP2_MIN_STATELESS_RESET_RANDLEN` bytes long.
 *
 * If |randlen| is too long to write them all in the buffer, |rand| is
 * written to the buffer as much as possible, and is truncated.
 *
 * This function returns the number of bytes written to the buffer, or
 * one of the following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small.
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     |randlen| is strictly less than
 *     :macro:`NGTCP2_MIN_STATELESS_RESET_RANDLEN`.
 *
 * This function has been available since v1.22.0.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_pkt_write_stateless_reset2(
  uint8_t *dest, size_t destlen, const ngtcp2_stateless_reset_token *token,
  const uint8_t *rand, size_t randlen);

/**
 * @function
 *
 * `ngtcp2_pkt_write_version_negotiation` writes Version Negotiation
 * packet in the buffer pointed by |dest| whose length is |destlen|.
 * |unused_random| should be generated randomly.  |dcid| is a
 * Connection ID which appeared in a packet as a Source Connection ID
 * sent by client which caused version negotiation.  Similarly, |scid|
 * is a Connection ID which appeared in a packet as a Destination
 * Connection ID sent by client.  |sv| is a list of supported
 * versions, and |nsv| specifies the number of supported versions
 * included in |sv|.
 *
 * This function returns the number of bytes written to the buffer, or
 * one of the following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_pkt_write_version_negotiation(
  uint8_t *dest, size_t destlen, uint8_t unused_random, const uint8_t *dcid,
  size_t dcidlen, const uint8_t *scid, size_t scidlen, const uint32_t *sv,
  size_t nsv);

/**
 * @struct
 *
 * :type:`ngtcp2_conn` represents a single QUIC connection.
 */
typedef struct ngtcp2_conn ngtcp2_conn;

/**
 * @functypedef
 *
 * :type:`ngtcp2_client_initial` is invoked when client application
 * asks TLS stack to produce first TLS cryptographic handshake data.
 *
 * This implementation of this callback must get the first handshake
 * data from TLS stack, and pass it to ngtcp2 library using
 * `ngtcp2_conn_submit_crypto_data` function.  Make sure that before
 * calling `ngtcp2_conn_submit_crypto_data` function, client
 * application must create initial packet protection keys and IVs, and
 * provide them to ngtcp2 library using
 * `ngtcp2_conn_install_initial_key`.
 *
 * This callback function must return 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library call
 * return immediately.
 */
typedef int (*ngtcp2_client_initial)(ngtcp2_conn *conn, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_client_initial` is invoked when server receives
 * Initial packet from client.  An server application must implement
 * this callback, and generate initial keys and IVs for both
 * transmission and reception.  Install them using
 * `ngtcp2_conn_install_initial_key`.  |dcid| is the Destination
 * Connection ID in Initial packet received from client.  It is used
 * to derive initial packet protection keys.
 *
 * The callback function must return 0 if it succeeds.  If an error
 * occurs, return :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the
 * library call return immediately.
 */
typedef int (*ngtcp2_recv_client_initial)(ngtcp2_conn *conn,
                                          const ngtcp2_cid *dcid,
                                          void *user_data);

/**
 * @enum
 *
 * :type:`ngtcp2_encryption_level` is QUIC encryption level.
 */
typedef enum ngtcp2_encryption_level {
  /**
   * :enum:`NGTCP2_ENCRYPTION_LEVEL_INITIAL` is Initial encryption
   * level.
   */
  NGTCP2_ENCRYPTION_LEVEL_INITIAL,
  /**
   * :enum:`NGTCP2_ENCRYPTION_LEVEL_HANDSHAKE` is Handshake encryption
   * level.
   */
  NGTCP2_ENCRYPTION_LEVEL_HANDSHAKE,
  /**
   * :enum:`NGTCP2_ENCRYPTION_LEVEL_1RTT` is 1-RTT encryption level.
   */
  NGTCP2_ENCRYPTION_LEVEL_1RTT,
  /**
   * :enum:`NGTCP2_ENCRYPTION_LEVEL_0RTT` is 0-RTT encryption level.
   */
  NGTCP2_ENCRYPTION_LEVEL_0RTT
} ngtcp2_encryption_level;

/**
 * @functypedef
 *
 * :type`ngtcp2_recv_crypto_data` is invoked when crypto data is
 * received.  The received data is pointed by |data|, and its length
 * is |datalen|.  The |offset| specifies the offset where |data| is
 * positioned.  |user_data| is the arbitrary pointer passed to
 * `ngtcp2_conn_client_new` or `ngtcp2_conn_server_new`.  The ngtcp2
 * library ensures that the crypto data is passed to the application
 * in the increasing order of |offset|.  |datalen| is always strictly
 * greater than 0.  |encryption_level| indicates the encryption level
 * where this data is received.  Crypto data can never be received in
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_0RTT`.
 *
 * The application should provide the given data to TLS stack.
 *
 * The callback function must return 0 if it succeeds, or one of the
 * following negative error codes:
 *
 * - :macro:`NGTCP2_ERR_CRYPTO`
 * - :macro:`NGTCP2_ERR_REQUIRED_TRANSPORT_PARAM`
 * - :macro:`NGTCP2_ERR_MALFORMED_TRANSPORT_PARAM`
 * - :macro:`NGTCP2_ERR_TRANSPORT_PARAM`
 * - :macro:`NGTCP2_ERR_PROTO`
 * - :macro:`NGTCP2_ERR_VERSION_NEGOTIATION_FAILURE`
 * - :macro:`NGTCP2_ERR_NOMEM`
 * - :macro:`NGTCP2_ERR_CALLBACK_FAILURE`
 *
 * If the other value is returned, it is treated as
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`.
 *
 * If application encounters fatal error, return
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library call
 * return immediately.
 */
typedef int (*ngtcp2_recv_crypto_data)(ngtcp2_conn *conn,
                                       ngtcp2_encryption_level encryption_level,
                                       uint64_t offset, const uint8_t *data,
                                       size_t datalen, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_handshake_completed` is invoked when QUIC
 * cryptographic handshake has completed.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_handshake_completed)(ngtcp2_conn *conn, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_handshake_confirmed` is invoked when QUIC
 * cryptographic handshake is confirmed.  The handshake confirmation
 * means that both endpoints agree that handshake has finished.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_handshake_confirmed)(ngtcp2_conn *conn, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_version_negotiation` is invoked when Version
 * Negotiation packet is received.  |hd| is the pointer to the QUIC
 * packet header object.  The vector |sv| of |nsv| elements contains
 * the QUIC version the server supports.  Since Version Negotiation is
 * only sent by server, this callback function is used by client only.
 *
 * The callback function must return 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library call
 * return immediately.
 */
typedef int (*ngtcp2_recv_version_negotiation)(ngtcp2_conn *conn,
                                               const ngtcp2_pkt_hd *hd,
                                               const uint32_t *sv, size_t nsv,
                                               void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_retry` is invoked when Retry packet is received.
 * This callback is client use only.
 *
 * Application must regenerate packet protection key, IV, and header
 * protection key for Initial packets using the Destination Connection
 * ID obtained by :member:`hd->scid <ngtcp2_pkt_hd.scid>`, and install
 * them by calling `ngtcp2_conn_install_initial_key`.
 *
 * 0-RTT data accepted by the ngtcp2 library will be automatically
 * retransmitted as 0-RTT data by the library.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_recv_retry)(ngtcp2_conn *conn, const ngtcp2_pkt_hd *hd,
                                 void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_encrypt` is invoked when the ngtcp2 library asks the
 * application to encrypt packet payload.  The packet payload to
 * encrypt is passed as |plaintext| of length |plaintextlen|.  The
 * AEAD cipher is |aead|.  |aead_ctx| is the AEAD cipher context
 * object which is initialized with the specific encryption key.  The
 * nonce is passed as |nonce| of length |noncelen|.  The Additional
 * Authenticated Data is passed as |aad| of length |aadlen|.
 *
 * The implementation of this callback must encrypt |plaintext| using
 * the negotiated cipher suite, and write the ciphertext into the
 * buffer pointed by |dest|.  |dest| has enough capacity to store the
 * ciphertext and any additional AEAD tag data.
 *
 * |dest| and |plaintext| may point to the same buffer.
 *
 * The callback function must return 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library call
 * return immediately.
 */
typedef int (*ngtcp2_encrypt)(uint8_t *dest, const ngtcp2_crypto_aead *aead,
                              const ngtcp2_crypto_aead_ctx *aead_ctx,
                              const uint8_t *plaintext, size_t plaintextlen,
                              const uint8_t *nonce, size_t noncelen,
                              const uint8_t *aad, size_t aadlen);

/**
 * @functypedef
 *
 * :type:`ngtcp2_decrypt` is invoked when the ngtcp2 library asks the
 * application to decrypt packet payload.  The packet payload to
 * decrypt is passed as |ciphertext| of length |ciphertextlen|.  The
 * AEAD cipher is |aead|.  |aead_ctx| is the AEAD cipher context
 * object which is initialized with the specific decryption key.  The
 * nonce is passed as |nonce| of length |noncelen|.  The Additional
 * Authenticated Data is passed as |aad| of length |aadlen|.
 *
 * The implementation of this callback must decrypt |ciphertext| using
 * the negotiated cipher suite, and write the ciphertext into the
 * buffer pointed by |dest|.  |dest| has enough capacity to store the
 * cleartext.
 *
 * |dest| and |ciphertext| may point to the same buffer.
 *
 * The callback function must return 0 if it succeeds.  If TLS stack
 * fails to decrypt data, return :macro:`NGTCP2_ERR_DECRYPT`.  For any
 * other errors, return :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which
 * makes the library call return immediately.
 */
typedef int (*ngtcp2_decrypt)(uint8_t *dest, const ngtcp2_crypto_aead *aead,
                              const ngtcp2_crypto_aead_ctx *aead_ctx,
                              const uint8_t *ciphertext, size_t ciphertextlen,
                              const uint8_t *nonce, size_t noncelen,
                              const uint8_t *aad, size_t aadlen);

/**
 * @functypedef
 *
 * :type:`ngtcp2_hp_mask` is invoked when the ngtcp2 library asks the
 * application to produce a mask to encrypt or decrypt packet header.
 * The encryption cipher is |hp|.  |hp_ctx| is the cipher context
 * object which is initialized with the specific header protection
 * key.  The sample is passed as |sample| which is
 * :macro:`NGTCP2_HP_SAMPLELEN` bytes long.
 *
 * The implementation of this callback must produce a mask using the
 * header protection cipher suite specified by QUIC specification, and
 * write the result into the buffer pointed by |dest|.  The length of
 * the mask must be at least :macro:`NGTCP2_HP_MASKLEN`.  The library
 * only uses the first :macro:`NGTCP2_HP_MASKLEN` bytes of the
 * produced mask.  The buffer pointed by |dest| is guaranteed to have
 * at least :macro:`NGTCP2_HP_SAMPLELEN` bytes available for
 * convenience.
 *
 * The callback function must return 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library call
 * return immediately.
 */
typedef int (*ngtcp2_hp_mask)(uint8_t *dest, const ngtcp2_crypto_cipher *hp,
                              const ngtcp2_crypto_cipher_ctx *hp_ctx,
                              const uint8_t *sample);

/**
 * @macrosection
 *
 * STREAM frame data flags
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_STREAM_DATA_FLAG_NONE` indicates no flag set.
 */
#define NGTCP2_STREAM_DATA_FLAG_NONE 0x00U

/**
 * @macro
 *
 * :macro:`NGTCP2_STREAM_DATA_FLAG_FIN` indicates that this chunk of
 * data is final piece of an incoming stream.
 */
#define NGTCP2_STREAM_DATA_FLAG_FIN 0x01U

/**
 * @macro
 *
 * :macro:`NGTCP2_STREAM_DATA_FLAG_0RTT` indicates that this chunk of
 * data contains data received in 0-RTT packet, and the handshake has
 * not completed yet, which means that the data might be replayed.
 */
#define NGTCP2_STREAM_DATA_FLAG_0RTT 0x02U

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_stream_data` is invoked when stream data is
 * received.  The stream is specified by |stream_id|.  |flags| is the
 * bitwise-OR of zero or more of :macro:`NGTCP2_STREAM_DATA_FLAG_*
 * <NGTCP2_STREAM_DATA_FLAG_NONE>`.  If |flags| &
 * :macro:`NGTCP2_STREAM_DATA_FLAG_FIN` is nonzero, this portion of
 * the data is the last data in this stream.  |offset| is the offset
 * where this data begins.  The library ensures that data is passed to
 * the application in the non-decreasing order of |offset| without any
 * overlap.  The data is passed as |data| of length |datalen|.
 * |datalen| may be 0 if and only if |fin| is nonzero.
 *
 * If :macro:`NGTCP2_STREAM_DATA_FLAG_0RTT` is set in |flags|, it
 * indicates that a part of or whole data was received in 0-RTT
 * packet, and a handshake has not completed yet.
 *
 * The callback function must return 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library return
 * immediately.
 */
typedef int (*ngtcp2_recv_stream_data)(ngtcp2_conn *conn, uint32_t flags,
                                       int64_t stream_id, uint64_t offset,
                                       const uint8_t *data, size_t datalen,
                                       void *user_data, void *stream_user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_stream_open` is a callback function which is called
 * when remote stream is opened by a remote endpoint.  This function
 * is not called if stream is opened by implicitly (we might
 * reconsider this behaviour later).
 *
 * The implementation of this callback should return 0 if it succeeds.
 * Returning :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library
 * call return immediately.
 */
typedef int (*ngtcp2_stream_open)(ngtcp2_conn *conn, int64_t stream_id,
                                  void *user_data);

/**
 * @macrosection
 *
 * Stream close flags
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_STREAM_CLOSE_FLAG_NONE` indicates no flag set.
 */
#define NGTCP2_STREAM_CLOSE_FLAG_NONE 0x00U

/**
 * @macro
 *
 * :macro:`NGTCP2_STREAM_CLOSE_FLAG_APP_ERROR_CODE_SET` indicates that
 * app_error_code parameter is set.
 */
#define NGTCP2_STREAM_CLOSE_FLAG_APP_ERROR_CODE_SET 0x01U

/**
 * @functypedef
 *
 * :type:`ngtcp2_stream_close` is invoked when a stream is closed.
 * This callback is not called when QUIC connection is closed before
 * existing streams are closed.  |flags| is the bitwise-OR of zero or
 * more of :macro:`NGTCP2_STREAM_CLOSE_FLAG_*
 * <NGTCP2_STREAM_CLOSE_FLAG_NONE>`.  |app_error_code| indicates the
 * error code of this closure if
 * :macro:`NGTCP2_STREAM_CLOSE_FLAG_APP_ERROR_CODE_SET` is set in
 * |flags|.  If it is not set, the stream was closed without any error
 * code, which generally means success.
 *
 * |app_error_code| is the first application error code sent by a
 * local endpoint, or received from a remote endpoint.  If a stream is
 * closed cleanly, no application error code is exchanged.  Since QUIC
 * stack does not know the application error code which indicates "no
 * errors", |app_error_code| is set to 0 and
 * :macro:`NGTCP2_STREAM_CLOSE_FLAG_APP_ERROR_CODE_SET` is not set in
 * |flags| in this case.
 *
 * The implementation of this callback should return 0 if it succeeds.
 * Returning :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library
 * call return immediately.
 */
typedef int (*ngtcp2_stream_close)(ngtcp2_conn *conn, uint32_t flags,
                                   int64_t stream_id, uint64_t app_error_code,
                                   void *user_data, void *stream_user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_stream_reset` is invoked when a stream identified by
 * |stream_id| is reset by a remote endpoint.
 *
 * The implementation of this callback should return 0 if it succeeds.
 * Returning :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library
 * call return immediately.
 */
typedef int (*ngtcp2_stream_reset)(ngtcp2_conn *conn, int64_t stream_id,
                                   uint64_t final_size, uint64_t app_error_code,
                                   void *user_data, void *stream_user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_acked_stream_data_offset` is a callback function
 * which is called when stream data in range [|offset|, |offset| +
 * |datalen|) is acknowledged, and application can free the portion of
 * data.  For a given |stream_id|, this callback is called
 * sequentially in increasing order of |offset| without any overlap.
 * |datalen| is normally strictly greater than 0.  One exception is
 * that when a STREAM frame has fin flag set and 0 length data, this
 * callback is invoked with |datalen| == 0.
 *
 * If a stream is closed prematurely, and stream data is still
 * in-flight, this callback function is not called for those data.
 * After :member:`ngtcp2_callbacks.stream_close` is called for a
 * particular stream, |conn| does not touch data for the closed stream
 * again, and application can free all unacknowledged stream data.
 *
 * The implementation of this callback should return 0 if it succeeds.
 * Returning :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library
 * call return immediately.
 */
typedef int (*ngtcp2_acked_stream_data_offset)(
  ngtcp2_conn *conn, int64_t stream_id, uint64_t offset, uint64_t datalen,
  void *user_data, void *stream_user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_stateless_reset` is a callback function which is
 * called when Stateless Reset packet is received.  The stateless
 * reset details are given in |sr|.
 *
 * The implementation of this callback should return 0 if it succeeds.
 * Returning :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library
 * call return immediately.
 *
 * Deprecated since v1.22.0.  Use :type:`ngtcp2_recv_stateless_reset2`
 * instead.
 */
typedef int (*ngtcp2_recv_stateless_reset)(ngtcp2_conn *conn,
                                           const ngtcp2_pkt_stateless_reset *sr,
                                           void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_extend_max_streams` is a callback function which is
 * called every time max stream ID is strictly extended.
 * |max_streams| is the cumulative number of streams which an endpoint
 * can open.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_extend_max_streams)(ngtcp2_conn *conn,
                                         uint64_t max_streams, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_extend_max_stream_data` is a callback function which
 * is invoked when max stream data is extended.  |stream_id|
 * identifies the stream.  |max_data| is a cumulative number of bytes
 * an endpoint can send on this stream.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_extend_max_stream_data)(ngtcp2_conn *conn,
                                             int64_t stream_id,
                                             uint64_t max_data, void *user_data,
                                             void *stream_user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_rand` is a callback function to get random data of
 * length |destlen|.  Application must fill random |destlen| bytes to
 * the buffer pointed by |dest|.  The generated data is used only in
 * non-cryptographic context.  But it is strongly recommended to use a
 * secure random number generator.
 */
typedef void (*ngtcp2_rand)(uint8_t *dest, size_t destlen,
                            const ngtcp2_rand_ctx *rand_ctx);

/**
 * @functypedef
 *
 * :type:`ngtcp2_get_new_connection_id` is a callback function to ask
 * an application for new connection ID.  Application must generate
 * new unused connection ID with the exact |cidlen| bytes, and store
 * it in |cid|.  It also has to generate a stateless reset token, and
 * store it in |token|.  The length of stateless reset token is
 * :macro:`NGTCP2_STATELESS_RESET_TOKENLEN` and it is guaranteed that
 * the buffer pointed by |token| has the sufficient space to store the
 * token.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 *
 * Deprecated since v1.22.0.  Use
 * :type:`ngtcp2_get_new_connection_id2` instead.
 */
typedef int (*ngtcp2_get_new_connection_id)(ngtcp2_conn *conn, ngtcp2_cid *cid,
                                            uint8_t *token, size_t cidlen,
                                            void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_remove_connection_id` is a callback function which
 * notifies the application that connection ID |cid| is no longer used
 * by a remote endpoint.  This Connection ID was previously offered by
 * a local endpoint, and a remote endpoint could use it as Destination
 * Connection ID when sending QUIC packet.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_remove_connection_id)(ngtcp2_conn *conn,
                                           const ngtcp2_cid *cid,
                                           void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_update_key` is a callback function which tells the
 * application that it must generate new packet protection keying
 * materials and AEAD cipher context objects with new keys.  The
 * current set of secrets are given as |current_rx_secret| and
 * |current_tx_secret| of length |secretlen|.  They are decryption and
 * encryption secrets respectively.
 *
 * The application must generate new secrets and keys for both
 * encryption and decryption.  It must write decryption secret and IV
 * to the buffer pointed by |rx_secret| and |rx_iv| respectively.  It
 * also must create new AEAD cipher context object with new decryption
 * key and initialize |rx_aead_ctx| with it.  Similarly, write
 * encryption secret and IV to the buffer pointed by |tx_secret| and
 * |tx_iv|.  Create new AEAD cipher context object with new encryption
 * key and initialize |tx_aead_ctx| with it.  All given buffers have
 * the enough capacity to store secret, key and IV.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_update_key)(
  ngtcp2_conn *conn, uint8_t *rx_secret, uint8_t *tx_secret,
  ngtcp2_crypto_aead_ctx *rx_aead_ctx, uint8_t *rx_iv,
  ngtcp2_crypto_aead_ctx *tx_aead_ctx, uint8_t *tx_iv,
  const uint8_t *current_rx_secret, const uint8_t *current_tx_secret,
  size_t secretlen, void *user_data);

/**
 * @macrosection
 *
 * Path validation related macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_PATH_VALIDATION_FLAG_NONE` indicates no flag set.
 */
#define NGTCP2_PATH_VALIDATION_FLAG_NONE 0x00U

/**
 * @macro
 *
 * :macro:`NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR` indicates the
 * validation involving server preferred address.  This flag is only
 * set for client.
 */
#define NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR 0x01U

/**
 * @macro
 *
 * :macro:`NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN` indicates that
 * server should send NEW_TOKEN frame for the new remote address.
 * This flag is only set for server.
 */
#define NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN 0x02U

/**
 * @functypedef
 *
 * :type:`ngtcp2_begin_path_validation` is a callback function which
 * is called when the path validation has started.  |flags| is zero or
 * more of :macro:`NGTCP2_PATH_VALIDATION_FLAG_*
 * <NGTCP2_PATH_VALIDATION_FLAG_NONE>`.  |path| is the path that is
 * being validated.  |fallback_path|, if not NULL, is the path that is
 * used when this validation fails.
 *
 * Currently, the flags may only contain
 * :macro:`NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR`.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_begin_path_validation)(ngtcp2_conn *conn, uint32_t flags,
                                            const ngtcp2_path *path,
                                            const ngtcp2_path *fallback_path,
                                            void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_path_validation` is a callback function which tells
 * an application the outcome of path validation.  |flags| is zero or
 * more of :macro:`NGTCP2_PATH_VALIDATION_FLAG_*
 * <NGTCP2_PATH_VALIDATION_FLAG_NONE>`.  |path| is the path that was
 * validated.  |fallback_path|, if not NULL, is the path that is used
 * if the path validation failed.  If |res| is
 * :enum:`ngtcp2_path_validation_result.NGTCP2_PATH_VALIDATION_RESULT_SUCCESS`,
 * the path validation succeeded.  If |res| is
 * :enum:`ngtcp2_path_validation_result.NGTCP2_PATH_VALIDATION_RESULT_FAILURE`,
 * the path validation failed.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_path_validation)(ngtcp2_conn *conn, uint32_t flags,
                                      const ngtcp2_path *path,
                                      const ngtcp2_path *fallback_path,
                                      ngtcp2_path_validation_result res,
                                      void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_select_preferred_addr` is a callback function which
 * asks a client application to choose server address from preferred
 * addresses |paddr| received from server.  An application should
 * write a network path for a selected preferred address in |dest|.
 * More specifically, the selected preferred address must be set to
 * :member:`dest->remote <ngtcp2_path.remote>`, a client source
 * address must be set to :member:`dest->local <ngtcp2_path.local>`.
 * If a client source address does not change for the new server
 * address, leave :member:`dest->local <ngtcp2_path.local>`
 * unmodified, or copy the value of :member:`local
 * <ngtcp2_path.local>` field of the current network path obtained
 * from `ngtcp2_conn_get_path()`.  Both :member:`dest->local.addr
 * <ngtcp2_addr.addr>` and :member:`dest->remote.addr
 * <ngtcp2_addr.addr>` point to buffers which are at least
 * sizeof(:type:`ngtcp2_sockaddr_union`) bytes long, respectively.  If
 * an application denies the preferred addresses, just leave |dest|
 * unmodified (or set :member:`dest->remote.addrlen
 * <ngtcp2_addr.addrlen>` to 0), and return 0.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_select_preferred_addr)(ngtcp2_conn *conn,
                                            ngtcp2_path *dest,
                                            const ngtcp2_preferred_addr *paddr,
                                            void *user_data);

/**
 * @enum
 *
 * :type:`ngtcp2_connection_id_status_type` defines a set of status
 * for Destination Connection ID.
 */
typedef enum ngtcp2_connection_id_status_type {
  /**
   * :enum:`NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE` indicates that
   * a local endpoint starts using new Destination Connection ID.
   */
  NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE,
  /**
   * :enum:`NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE` indicates
   * that a local endpoint stops using a given Destination Connection
   * ID.
   */
  NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE
} ngtcp2_connection_id_status_type;

/**
 * @functypedef
 *
 * :type:`ngtcp2_connection_id_status` is a callback function which is
 * called when the status of Destination Connection ID changes.
 *
 * |token| is the associated stateless reset token, and it is ``NULL``
 * if no token is present.
 *
 * |type| is the one of the value defined in
 * :type:`ngtcp2_connection_id_status_type`.  The new value might be
 * added in the future release.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 *
 * Deprecated since v1.22.0.  Use :type:`ngtcp2_connection_id_status2`
 * instead.
 */
typedef int (*ngtcp2_connection_id_status)(
  ngtcp2_conn *conn, ngtcp2_connection_id_status_type type, uint64_t seq,
  const ngtcp2_cid *cid, const uint8_t *token, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_new_token` is a callback function which is
 * called when new token is received from server.  This callback is
 * client use only.
 *
 * |token| is the received token of length |tokenlen| bytes long.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_recv_new_token)(ngtcp2_conn *conn, const uint8_t *token,
                                     size_t tokenlen, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_delete_crypto_aead_ctx` is a callback function which
 * must delete the native object pointed by
 * :member:`aead_ctx->native_handle
 * <ngtcp2_crypto_aead_ctx.native_handle>`.
 */
typedef void (*ngtcp2_delete_crypto_aead_ctx)(ngtcp2_conn *conn,
                                              ngtcp2_crypto_aead_ctx *aead_ctx,
                                              void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_delete_crypto_cipher_ctx` is a callback function
 * which must delete the native object pointed by
 * :member:`cipher_ctx->native_handle
 * <ngtcp2_crypto_cipher_ctx.native_handle>`.
 */
typedef void (*ngtcp2_delete_crypto_cipher_ctx)(
  ngtcp2_conn *conn, ngtcp2_crypto_cipher_ctx *cipher_ctx, void *user_data);

/**
 * @macrosection
 *
 * DATAGRAM frame flags
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_DATAGRAM_FLAG_NONE` indicates no flag set.
 */
#define NGTCP2_DATAGRAM_FLAG_NONE 0x00U

/**
 * @macro
 *
 * :macro:`NGTCP2_DATAGRAM_FLAG_0RTT` indicates that DATAGRAM frame is
 * received in 0-RTT packet, and the handshake has not completed yet,
 * which means that the data might be replayed.
 */
#define NGTCP2_DATAGRAM_FLAG_0RTT 0x01U

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_datagram` is invoked when DATAGRAM frame is
 * received.  |flags| is bitwise-OR of zero or more of
 * :macro:`NGTCP2_DATAGRAM_FLAG_* <NGTCP2_DATAGRAM_FLAG_NONE>`.
 *
 * If :macro:`NGTCP2_DATAGRAM_FLAG_0RTT` is set in |flags|, it
 * indicates that DATAGRAM frame was received in 0-RTT packet, and a
 * handshake has not completed yet.
 *
 * The callback function must return 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library return
 * immediately.
 */
typedef int (*ngtcp2_recv_datagram)(ngtcp2_conn *conn, uint32_t flags,
                                    const uint8_t *data, size_t datalen,
                                    void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_ack_datagram` is invoked when a packet which contains
 * DATAGRAM frame which is identified by |dgram_id| is acknowledged.
 * |dgram_id| is the valued passed to `ngtcp2_conn_writev_datagram`.
 *
 * The callback function must return 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library return
 * immediately.
 */
typedef int (*ngtcp2_ack_datagram)(ngtcp2_conn *conn, uint64_t dgram_id,
                                   void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_lost_datagram` is invoked when a packet which
 * contains DATAGRAM frame which is identified by |dgram_id| is
 * declared lost.  |dgram_id| is the valued passed to
 * `ngtcp2_conn_writev_datagram`.  Note that the loss might be
 * spurious, and DATAGRAM frame might be acknowledged later.
 *
 * The callback function must return 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` which makes the library return
 * immediately.
 */
typedef int (*ngtcp2_lost_datagram)(ngtcp2_conn *conn, uint64_t dgram_id,
                                    void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_get_path_challenge_data` is a callback function to
 * ask an application for new data that is sent in PATH_CHALLENGE
 * frame.  Application must generate new unpredictable, exactly
 * :macro:`NGTCP2_PATH_CHALLENGE_DATALEN` bytes of random data, and
 * store them into the buffer pointed by |data|.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 *
 * Deprecated since v1.22.0.  Use
 * :type:`ngtcp2_get_path_challenge_data2` instead.
 */
typedef int (*ngtcp2_get_path_challenge_data)(ngtcp2_conn *conn, uint8_t *data,
                                              void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_stream_stop_sending` is invoked when a stream is no
 * longer read by a local endpoint before it receives all stream data.
 * This function is called at most once per stream.  |app_error_code|
 * is the error code passed to `ngtcp2_conn_shutdown_stream_read` or
 * `ngtcp2_conn_shutdown_stream`.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_stream_stop_sending)(ngtcp2_conn *conn, int64_t stream_id,
                                          uint64_t app_error_code,
                                          void *user_data,
                                          void *stream_user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_version_negotiation` is invoked when the compatible
 * version negotiation takes place.  For client, it is called when it
 * sees a change in version field of a long header packet.  This
 * callback function might be called multiple times for client.  For
 * server, it is called once when the version is negotiated.
 *
 * The implementation of this callback must install new Initial keys
 * for |version| and Destination Connection ID |client_dcid| from
 * client.  Use `ngtcp2_conn_install_vneg_initial_key` to install
 * keys.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_version_negotiation)(ngtcp2_conn *conn, uint32_t version,
                                          const ngtcp2_cid *client_dcid,
                                          void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_key` is invoked when new key is installed to
 * |conn| during QUIC cryptographic handshake.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_recv_key)(ngtcp2_conn *conn, ngtcp2_encryption_level level,
                               void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_tls_early_data_rejected` is invoked when early data
 * was rejected by server during TLS handshake, or client decided not
 * to attempt early data.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 */
typedef int (*ngtcp2_tls_early_data_rejected)(ngtcp2_conn *conn,
                                              void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_recv_stateless_reset2` is a callback function which
 * is called when Stateless Reset packet is received.  The stateless
 * reset details are given in |sr|.
 *
 * The implementation of this callback should return 0 if it succeeds.
 * Returning :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library
 * call return immediately.
 *
 * This type has been available since v1.22.0
 */
typedef int (*ngtcp2_recv_stateless_reset2)(
  ngtcp2_conn *conn, const ngtcp2_pkt_stateless_reset2 *sr, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_get_new_connection_id2` is a callback function to ask
 * an application for new connection ID.  Application must generate
 * new unused connection ID with the exact |cidlen| bytes, and store
 * it in |cid|.  It also has to generate a stateless reset token, and
 * store it in |token|.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 *
 * This type has been available since v1.22.0
 */
typedef int (*ngtcp2_get_new_connection_id2)(
  ngtcp2_conn *conn, ngtcp2_cid *cid, ngtcp2_stateless_reset_token *token,
  size_t cidlen, void *user_data);

/**
 * @functypedef
 *
 * :type:`ngtcp2_connection_id_status2` is a callback function which
 * is called when the status of Destination Connection ID changes.
 *
 * |token| is the associated stateless reset token, and it is ``NULL``
 * if no token is present.
 *
 * |type| is the one of the value defined in
 * :type:`ngtcp2_connection_id_status_type`.  The new value might be
 * added in the future release.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 *
 * This type has been available since v1.22.0
 */
typedef int (*ngtcp2_connection_id_status2)(
  ngtcp2_conn *conn, ngtcp2_connection_id_status_type type, uint64_t seq,
  const ngtcp2_cid *cid, const ngtcp2_stateless_reset_token *token,
  void *user_data);

/**
 * @struct
 *
 * :type:`ngtcp2_path_challenge_data` stores path challenge data.
 *
 * This type has been available since v1.22.0.
 */
typedef struct ngtcp2_path_challenge_data {
  uint8_t data[NGTCP2_PATH_CHALLENGE_DATALEN];
} ngtcp2_path_challenge_data;

/**
 * @functypedef
 *
 * :type:`ngtcp2_get_path_challenge_data2` is a callback function to
 * ask an application for new data that is sent in PATH_CHALLENGE
 * frame.  Application must generate new unpredictable, exactly
 * :macro:`NGTCP2_PATH_CHALLENGE_DATALEN` bytes of random data, and
 * store them into |data|.
 *
 * The callback function must return 0 if it succeeds.  Returning
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE` makes the library call return
 * immediately.
 *
 * This type has been available since v1.22.0.
 */
typedef int (*ngtcp2_get_path_challenge_data2)(ngtcp2_conn *conn,
                                               ngtcp2_path_challenge_data *data,
                                               void *user_data);

#define NGTCP2_CALLBACKS_V1 1
#define NGTCP2_CALLBACKS_V2 2
#define NGTCP2_CALLBACKS_V3 3
#define NGTCP2_CALLBACKS_VERSION NGTCP2_CALLBACKS_V3

/**
 * @struct
 *
 * :type:`ngtcp2_callbacks` holds a set of callback functions.
 */
typedef struct ngtcp2_callbacks {
  /**
   * :member:`client_initial` is a callback function which is invoked
   * when client asks TLS stack to produce first TLS cryptographic
   * handshake message.  This callback function must be specified for
   * a client application.
   */
  ngtcp2_client_initial client_initial;
  /**
   * :member:`recv_client_initial` is a callback function which is
   * invoked when a server receives the first Initial packet from
   * client.  This callback function must be specified for a server
   * application.
   */
  ngtcp2_recv_client_initial recv_client_initial;
  /**
   * :member:`recv_crypto_data` is a callback function which is
   * invoked when cryptographic data (CRYPTO frame, in other words,
   * TLS message) is received.  This callback function must be
   * specified.
   */
  ngtcp2_recv_crypto_data recv_crypto_data;
  /**
   * :member:`handshake_completed` is a callback function which is
   * invoked when QUIC cryptographic handshake has completed.  This
   * callback function is optional.
   */
  ngtcp2_handshake_completed handshake_completed;
  /**
   * :member:`recv_version_negotiation` is a callback function which
   * is invoked when Version Negotiation packet is received by a
   * client.  This callback function is optional.
   */
  ngtcp2_recv_version_negotiation recv_version_negotiation;
  /**
   * :member:`encrypt` is a callback function which is invoked to
   * encrypt a QUIC packet.  This callback function must be specified.
   */
  ngtcp2_encrypt encrypt;
  /**
   * :member:`decrypt` is a callback function which is invoked to
   * decrypt a QUIC packet.  This callback function must be specified.
   */
  ngtcp2_decrypt decrypt;
  /**
   * :member:`hp_mask` is a callback function which is invoked to get
   * a mask to encrypt or decrypt QUIC packet header.  This callback
   * function must be specified.
   */
  ngtcp2_hp_mask hp_mask;
  /**
   * :member:`recv_stream_data` is a callback function which is
   * invoked when stream data, which includes application data, is
   * received.  This callback function is optional.
   */
  ngtcp2_recv_stream_data recv_stream_data;
  /**
   * :member:`acked_stream_data_offset` is a callback function which
   * is invoked when stream data, which includes application data, is
   * acknowledged by a remote endpoint.  It tells an application the
   * largest offset of acknowledged stream data without a gap so that
   * application can free memory for the data up to that offset.  This
   * callback function is optional.
   */
  ngtcp2_acked_stream_data_offset acked_stream_data_offset;
  /**
   * :member:`stream_open` is a callback function which is invoked
   * when new remote stream is opened by a remote endpoint.  This
   * callback function is optional.
   */
  ngtcp2_stream_open stream_open;
  /**
   * :member:`stream_close` is a callback function which is invoked
   * when a stream is closed.  This callback function is optional.
   */
  ngtcp2_stream_close stream_close;
  /**
   * :member:`recv_stateless_reset` is a callback function which is
   * invoked when Stateless Reset packet is received.  This callback
   * function is optional.
   *
   * Deprecated since v1.22.0.  Use :member:`recv_stateless_reset2`
   * instead.  If both :member:`recv_stateless_reset` and
   * :member:`recv_stateless_reset2` are set, the latter has the
   * precedence.
   */
  ngtcp2_recv_stateless_reset recv_stateless_reset;
  /**
   * :member:`recv_retry` is a callback function which is invoked when
   * a client receives Retry packet.  For client, this callback
   * function must be specified.  Server never receive Retry packet.
   */
  ngtcp2_recv_retry recv_retry;
  /**
   * :member:`extend_max_local_streams_bidi` is a callback function
   * which is invoked when the number of bidirectional stream which a
   * local endpoint can open is increased.  This callback function is
   * optional.
   */
  ngtcp2_extend_max_streams extend_max_local_streams_bidi;
  /**
   * :member:`extend_max_local_streams_uni` is a callback function
   * which is invoked when the number of unidirectional stream which a
   * local endpoint can open is increased.  This callback function is
   * optional.
   */
  ngtcp2_extend_max_streams extend_max_local_streams_uni;
  /**
   * :member:`rand` is a callback function which is invoked when the
   * library needs random data.  This callback function must be
   * specified.
   */
  ngtcp2_rand rand;
  /**
   * :member:`get_new_connection_id` is a callback function which is
   * invoked when the library needs new connection ID.  Either this
   * callback function or :member:`get_new_connection_id2` must be
   * specified.
   *
   * Deprecated since v1.22.0.  Use :member:`get_new_connection_id2`
   * instead.  If both :member:`get_new_connection_id` and
   * :member:`get_new_connection_id2` are set, the latter has the
   * precedence.
   */
  ngtcp2_get_new_connection_id get_new_connection_id;
  /**
   * :member:`remove_connection_id` is a callback function which
   * notifies an application that connection ID is no longer used by a
   * remote endpoint.  This callback function is optional.
   */
  ngtcp2_remove_connection_id remove_connection_id;
  /**
   * :member:`update_key` is a callback function which is invoked when
   * the library tells an application that it must update keying
   * materials, and install new keys.  This callback function must be
   * specified.
   */
  ngtcp2_update_key update_key;
  /**
   * :member:`path_validation` is a callback function which is invoked
   * when path validation completed.  This callback function is
   * optional.
   */
  ngtcp2_path_validation path_validation;
  /**
   * :member:`select_preferred_addr` is a callback function which is
   * invoked when the library asks a client to select preferred
   * address presented by a server.  If not set, client ignores
   * preferred addresses.  This callback function is optional.
   */
  ngtcp2_select_preferred_addr select_preferred_addr;
  /**
   * :member:`stream_reset` is a callback function which is invoked
   * when a stream is reset by a remote endpoint.  This callback
   * function is optional.
   */
  ngtcp2_stream_reset stream_reset;
  /**
   * :member:`extend_max_remote_streams_bidi` is a callback function
   * which is invoked when the number of bidirectional streams which a
   * remote endpoint can open is increased.  This callback function is
   * optional.
   */
  ngtcp2_extend_max_streams extend_max_remote_streams_bidi;
  /**
   * :member:`extend_max_remote_streams_uni` is a callback function
   * which is invoked when the number of unidirectional streams which
   * a remote endpoint can open is increased.  This callback function
   * is optional.
   */
  ngtcp2_extend_max_streams extend_max_remote_streams_uni;
  /**
   * :member:`extend_max_stream_data` is callback function which is
   * invoked when the maximum offset of stream data that a local
   * endpoint can send is increased.  This callback function is
   * optional.
   */
  ngtcp2_extend_max_stream_data extend_max_stream_data;
  /**
   * :member:`dcid_status` is a callback function which is invoked
   * when the new Destination Connection ID is activated, or the
   * activated Destination Connection ID is now deactivated.  This
   * callback function is optional.
   *
   * Deprecated since v1.22.0.  Use :member:`dcid_status2` instead.
   * If both :member:`dcid_status` and :member:`dcid_status2` are set,
   * the latter has the precedence.
   */
  ngtcp2_connection_id_status dcid_status;
  /**
   * :member:`handshake_confirmed` is a callback function which is
   * invoked when both endpoints agree that handshake has finished.
   * This field is ignored by server because
   * :member:`handshake_completed` also indicates the handshake
   * confirmation for server.  This callback function is optional.
   */
  ngtcp2_handshake_confirmed handshake_confirmed;
  /**
   * :member:`recv_new_token` is a callback function which is invoked
   * when new token is received from server.  This field is ignored by
   * server.  This callback function is optional.
   */
  ngtcp2_recv_new_token recv_new_token;
  /**
   * :member:`delete_crypto_aead_ctx` is a callback function which
   * deletes a given AEAD cipher context object.  This callback
   * function must be specified.
   */
  ngtcp2_delete_crypto_aead_ctx delete_crypto_aead_ctx;
  /**
   * :member:`delete_crypto_cipher_ctx` is a callback function which
   * deletes a given cipher context object.  This callback function
   * must be specified.
   */
  ngtcp2_delete_crypto_cipher_ctx delete_crypto_cipher_ctx;
  /**
   * :member:`recv_datagram` is a callback function which is invoked
   * when DATAGRAM frame is received.  This callback function is
   * optional.
   */
  ngtcp2_recv_datagram recv_datagram;
  /**
   * :member:`ack_datagram` is a callback function which is invoked
   * when a QUIC packet containing DATAGRAM frame is acknowledged by a
   * remote endpoint.  This callback function is optional.
   */
  ngtcp2_ack_datagram ack_datagram;
  /**
   * :member:`lost_datagram` is a callback function which is invoked
   * when a QUIC packet containing DATAGRAM frame is declared lost.
   * This callback function is optional.
   */
  ngtcp2_lost_datagram lost_datagram;
  /**
   * :member:`get_path_challenge_data` is a callback function which is
   * invoked when the library needs new data sent along with
   * PATH_CHALLENGE frame.  This callback must be specified.
   *
   * Deprecated since v1.22.0.  Use :member:`get_path_challenge_data2`
   * instead.
   */
  ngtcp2_get_path_challenge_data get_path_challenge_data;
  /**
   * :member:`stream_stop_sending` is a callback function which is
   * invoked when a local endpoint no longer reads from a stream
   * before it receives all stream data.  This callback function is
   * optional.
   */
  ngtcp2_stream_stop_sending stream_stop_sending;
  /**
   * :member:`version_negotiation` is a callback function which is
   * invoked when the compatible version negotiation takes place.
   * This callback function must be specified.
   */
  ngtcp2_version_negotiation version_negotiation;
  /**
   * :member:`recv_rx_key` is a callback function which is invoked
   * when a new key for decrypting packets is installed during QUIC
   * cryptographic handshake.  It is not called for
   * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_INITIAL`.
   */
  ngtcp2_recv_key recv_rx_key;
  /**
   * :member:`recv_tx_key` is a callback function which is invoked
   * when a new key for encrypting packets is installed during QUIC
   * cryptographic handshake.  It is not called for
   * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_INITIAL`.
   */
  ngtcp2_recv_key recv_tx_key;
  /**
   * :member:`tls_early_data_rejected` is a callback function which is
   * invoked when server rejected early data during TLS handshake, or
   * client decided not to attempt early data.  This callback function
   * is only used by client.
   */
  ngtcp2_tls_early_data_rejected tls_early_data_rejected;
  /* The following fields have been added since NGTCP2_CALLBACKS_V2. */
  /**
   * :member:`begin_path_validation` is a callback function which is
   * invoked when a path validation has started.  This field is
   * available since v1.14.0.
   */
  ngtcp2_begin_path_validation begin_path_validation;
  /* The following fields have been added since NGTCP2_CALLBACKS_V3. */
  /**
   * :member:`recv_stateless_reset2` is a callback function which is
   * invoked when Stateless Reset packet is received.  This callback
   * function is optional.  This field is available since v1.22.0.
   */
  ngtcp2_recv_stateless_reset2 recv_stateless_reset2;
  /**
   * :member:`get_new_connection_id2` is a callback function which is
   * invoked when the library needs new connection ID.  This callback
   * function must be specified.  This field is available since
   * v1.22.0.
   */
  ngtcp2_get_new_connection_id2 get_new_connection_id2;
  /**
   * :member:`dcid_status2` is a callback function which is invoked
   * when the new Destination Connection ID is activated, or the
   * activated Destination Connection ID is now deactivated.  This
   * callback function is optional.  This field is available since
   * v1.22.0.
   */
  ngtcp2_connection_id_status2 dcid_status2;
  /**
   * :member:`get_path_challenge_data2` is a callback function which
   * is invoked when the library needs new data sent along with
   * PATH_CHALLENGE frame.  This callback must be specified.  This
   * field is available since v1.22.0.
   */
  ngtcp2_get_path_challenge_data2 get_path_challenge_data2;
} ngtcp2_callbacks;

/**
 * @function
 *
 * `ngtcp2_pkt_write_connection_close` writes Initial packet
 * containing CONNECTION_CLOSE frame with the given |error_code| and
 * the optional |reason| of length |reasonlen| to the buffer pointed
 * by |dest| of length |destlen|.  All encryption parameters are for
 * Initial packet encryption.  The packet number is always 0.
 *
 * The primary use case of this function is for server to send
 * CONNECTION_CLOSE frame in Initial packet to close connection
 * without committing any state when validating Retry token fails.
 *
 * This function returns the number of bytes written if it succeeds,
 * or one of the following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small.
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`
 *     Callback function failed.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_pkt_write_connection_close(
  uint8_t *dest, size_t destlen, uint32_t version, const ngtcp2_cid *dcid,
  const ngtcp2_cid *scid, uint64_t error_code, const uint8_t *reason,
  size_t reasonlen, ngtcp2_encrypt encrypt, const ngtcp2_crypto_aead *aead,
  const ngtcp2_crypto_aead_ctx *aead_ctx, const uint8_t *iv,
  ngtcp2_hp_mask hp_mask, const ngtcp2_crypto_cipher *hp,
  const ngtcp2_crypto_cipher_ctx *hp_ctx);

/**
 * @function
 *
 * `ngtcp2_pkt_write_retry` writes Retry packet in the buffer pointed
 * by |dest| whose length is |destlen|.  |dcid| is the Connection ID
 * which appeared in a packet as a Source Connection ID sent by
 * client.  |scid| is a server chosen Source Connection ID.  |odcid|
 * specifies Original Destination Connection ID which appeared in a
 * packet as a Destination Connection ID sent by client.  |token|
 * specifies Retry Token, and |tokenlen| specifies its length.  |aead|
 * must be AEAD_AES_128_GCM.  |aead_ctx| must be initialized with
 * :macro:`NGTCP2_RETRY_KEY` as an encryption key.
 *
 * This function returns the number of bytes written to the buffer, or
 * one of the following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small.
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`
 *     Callback function failed.
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     :member:`odcid->datalen <ngtcp2_cid.datalen>` is less than
 *     :macro:`NGTCP2_MIN_INITIAL_DCIDLEN`.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_pkt_write_retry(
  uint8_t *dest, size_t destlen, uint32_t version, const ngtcp2_cid *dcid,
  const ngtcp2_cid *scid, const ngtcp2_cid *odcid, const uint8_t *token,
  size_t tokenlen, ngtcp2_encrypt encrypt, const ngtcp2_crypto_aead *aead,
  const ngtcp2_crypto_aead_ctx *aead_ctx);

/**
 * @function
 *
 * `ngtcp2_accept` is used by server implementation, and decides
 * whether packet |pkt| of length |pktlen| from client is acceptable
 * for the very first packet to a connection.
 *
 * If |dest| is not ``NULL`` and the function returns 0, the decoded
 * packet header is stored in the object pointed by |dest|.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     The packet is not acceptable for the very first packet to a new
 *     connection; or the function failed to parse the packet header.
 */
NGTCP2_EXTERN int ngtcp2_accept(ngtcp2_pkt_hd *dest, const uint8_t *pkt,
                                size_t pktlen);

/**
 * @function
 *
 * `ngtcp2_conn_client_new` creates new :type:`ngtcp2_conn`, and
 * initializes it as client.  On success, it stores the pointer to the
 * newly allocated object in |*pconn|.  |dcid| is a randomized
 * Destination Connection ID which must be longer than or equal to
 * :macro:`NGTCP2_MIN_INITIAL_DCIDLEN`.  |scid| is a Source Connection
 * ID chosen by client.  |client_chosen_version| is a QUIC version
 * that a client chooses.  |path| is the network path where this QUIC
 * connection is being established, and must not be ``NULL``.
 * |callbacks|, |settings|, and |params| must not be ``NULL``, and the
 * function makes a copy of each of them.  |params| is a local QUIC
 * transport parameters, and sent to a remote endpoint during
 * handshake.  |user_data| is the arbitrary pointer which is passed to
 * the user-defined callback functions.  If |mem| is ``NULL``, the
 * memory allocator returned by `ngtcp2_mem_default()` is used.
 *
 * Call `ngtcp2_conn_del` to free memory allocated for |*pconn|.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_client_new_versioned(
  ngtcp2_conn **pconn, const ngtcp2_cid *dcid, const ngtcp2_cid *scid,
  const ngtcp2_path *path, uint32_t client_chosen_version,
  int callbacks_version, const ngtcp2_callbacks *callbacks,
  int settings_version, const ngtcp2_settings *settings,
  int transport_params_version, const ngtcp2_transport_params *params,
  const ngtcp2_mem *mem, void *user_data);

/**
 * @function
 *
 * `ngtcp2_conn_server_new` creates new :type:`ngtcp2_conn`, and
 * initializes it as server.  On success, it stores the pointer to the
 * newly allocated object in |*pconn|.  |dcid| is a Destination
 * Connection ID, and is usually the Connection ID that appears in
 * client Initial packet as Source Connection ID.  |scid| is a Source
 * Connection ID chosen by server.  |path| is the network path where
 * this QUIC connection is being established, and must not be
 * ``NULL``.  |client_chosen_version| is a QUIC version that a client
 * chooses.  |callbacks|, |settings|, and |params| must not be
 * ``NULL``, and the function makes a copy of each of them.  |params|
 * is a local QUIC transport parameters, and sent to a remote endpoint
 * during handshake.  |user_data| is the arbitrary pointer which is
 * passed to the user-defined callback functions.  If |mem| is
 * ``NULL``, the memory allocator returned by `ngtcp2_mem_default()`
 * is used.
 *
 * Call `ngtcp2_conn_del` to free memory allocated for |*pconn|.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_server_new_versioned(
  ngtcp2_conn **pconn, const ngtcp2_cid *dcid, const ngtcp2_cid *scid,
  const ngtcp2_path *path, uint32_t client_chosen_version,
  int callbacks_version, const ngtcp2_callbacks *callbacks,
  int settings_version, const ngtcp2_settings *settings,
  int transport_params_version, const ngtcp2_transport_params *params,
  const ngtcp2_mem *mem, void *user_data);

/**
 * @function
 *
 * `ngtcp2_conn_del` frees resources allocated for |conn|.  It also
 * frees memory pointed by |conn|.
 */
NGTCP2_EXTERN void ngtcp2_conn_del(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_read_pkt` decrypts QUIC packet given in |pkt| of
 * length |pktlen| and processes it.  |path| is the network path the
 * packet is delivered and must not be ``NULL``.  |pi| is packet
 * metadata and may be ``NULL``. This function performs QUIC handshake
 * as well.
 *
 * This function must not be called from inside the callback
 * functions.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_RETRY`
 *    Server must perform address validation by sending Retry packet
 *    (see `ngtcp2_crypto_write_retry` and `ngtcp2_pkt_write_retry`),
 *    and discard the connection state.  Client application does not
 *    get this error code.
 * :macro:`NGTCP2_ERR_DROP_CONN`
 *    Server application must drop the connection silently (without
 *    sending any CONNECTION_CLOSE frame), and discard connection
 *    state.  Client application does not get this error code.
 * :macro:`NGTCP2_ERR_DRAINING`
 *    A connection has entered the draining state, and no further
 *    packet transmission is allowed.
 * :macro:`NGTCP2_ERR_CLOSING`
 *    A connection has entered the closing state, and no further
 *    packet transmission is allowed.  Calling
 *    `ngtcp2_conn_write_connection_close` makes a connection enter
 *    this state.
 * :macro:`NGTCP2_ERR_CRYPTO`
 *    An error happened in TLS stack.  `ngtcp2_conn_get_tls_alert`
 *    returns TLS alert if set.
 *
 * If any other negative error is returned, call
 * `ngtcp2_conn_write_connection_close` to get terminal packet, and
 * sending it makes QUIC connection enter the closing state.
 */
NGTCP2_EXTERN int
ngtcp2_conn_read_pkt_versioned(ngtcp2_conn *conn, const ngtcp2_path *path,
                               int pkt_info_version, const ngtcp2_pkt_info *pi,
                               const uint8_t *pkt, size_t pktlen,
                               ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_write_pkt` is equivalent to calling
 * `ngtcp2_conn_writev_stream` with -1 as |stream_id|, no stream data,
 * and :macro:`NGTCP2_WRITE_STREAM_FLAG_NONE` as flags.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_write_pkt_versioned(
  ngtcp2_conn *conn, ngtcp2_path *path, int pkt_info_version,
  ngtcp2_pkt_info *pi, uint8_t *dest, size_t destlen, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_continue_handshake` resumes handshake interrupted by
 * TLS stack routine (e.g., private key operation offloading,
 * certificate lookup, etc).
 *
 * This function returns 0 if it succeeds.  In general, this function
 * returns the same set of error codes from `ngtcp2_conn_read_pkt`.
 *
 * This function has been available since v1.22.0.
 */
NGTCP2_EXTERN int ngtcp2_conn_continue_handshake(ngtcp2_conn *conn,
                                                 ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_tls_handshake_completed` tells |conn| that the TLS
 * stack declares TLS handshake completion.  This does not mean QUIC
 * handshake has completed.  The library needs extra conditions to be
 * met.
 */
NGTCP2_EXTERN void ngtcp2_conn_tls_handshake_completed(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_handshake_completed` returns nonzero if QUIC
 * handshake has completed.
 */
NGTCP2_EXTERN int ngtcp2_conn_get_handshake_completed(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_install_initial_key` installs packet protection keying
 * materials for Initial packets.  |rx_aead_ctx| is AEAD cipher
 * context object, and must be initialized with a decryption key.
 * |rx_iv| is IV of length |rx_ivlen| for decryption.  |rx_hp_ctx| is
 * a packet header protection cipher context object for decryption.
 * Similarly, |tx_aead_ctx|, |tx_iv| and |tx_hp_ctx| are for
 * encrypting outgoing packets, and are the same length with the
 * decryption counterpart .  If they have already been set, they are
 * overwritten.
 *
 * |ivlen| must be the minimum length of AEAD nonce, or 8 bytes if
 * that is larger.
 *
 * If this function succeeds, |conn| takes ownership of |rx_aead_ctx|,
 * |rx_hp_ctx|, |tx_aead_ctx|, and |tx_hp_ctx|.
 * :member:`ngtcp2_callbacks.delete_crypto_aead_ctx` and
 * :member:`ngtcp2_callbacks.delete_crypto_cipher_ctx` will be called
 * to delete these objects when they are no longer used.  If this
 * function fails, the caller is responsible to delete them.
 *
 * After receiving Retry packet, a Destination Connection ID that
 * client sends in Initial packet most likely changes.  In that case,
 * client application must generate these keying materials again based
 * on new Destination Connection ID, and install them again with this
 * function.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_install_initial_key(
  ngtcp2_conn *conn, const ngtcp2_crypto_aead_ctx *rx_aead_ctx,
  const uint8_t *rx_iv, const ngtcp2_crypto_cipher_ctx *rx_hp_ctx,
  const ngtcp2_crypto_aead_ctx *tx_aead_ctx, const uint8_t *tx_iv,
  const ngtcp2_crypto_cipher_ctx *tx_hp_ctx, size_t ivlen);

/**
 * @function
 *
 * `ngtcp2_conn_install_vneg_initial_key` installs packet protection
 * keying materials for Initial packets on compatible version
 * negotiation for |version|.  |rx_aead_ctx| is AEAD cipher context
 * object, and must be initialized with a decryption key.  |rx_iv| is
 * IV of length |rx_ivlen| for decryption.  |rx_hp_ctx| is a packet
 * header protection cipher context object for decryption.  Similarly,
 * |tx_aead_ctx|, |tx_iv| and |tx_hp_ctx| are for encrypting outgoing
 * packets, and are the same length with the decryption counterpart.
 * If they have already been set, they are overwritten.
 *
 * |ivlen| must be the minimum length of AEAD nonce, or 8 bytes if
 * that is larger.
 *
 * If this function succeeds, |conn| takes ownership of |rx_aead_ctx|,
 * |rx_hp_ctx|, |tx_aead_ctx|, and |tx_hp_ctx|.
 * :member:`ngtcp2_callbacks.delete_crypto_aead_ctx` and
 * :member:`ngtcp2_callbacks.delete_crypto_cipher_ctx` will be called
 * to delete these objects when they are no longer used.  If this
 * function fails, the caller is responsible to delete them.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_install_vneg_initial_key(
  ngtcp2_conn *conn, uint32_t version,
  const ngtcp2_crypto_aead_ctx *rx_aead_ctx, const uint8_t *rx_iv,
  const ngtcp2_crypto_cipher_ctx *rx_hp_ctx,
  const ngtcp2_crypto_aead_ctx *tx_aead_ctx, const uint8_t *tx_iv,
  const ngtcp2_crypto_cipher_ctx *tx_hp_ctx, size_t ivlen);

/**
 * @function
 *
 * `ngtcp2_conn_install_rx_handshake_key` installs packet protection
 * keying materials for decrypting incoming Handshake packets.
 * |aead_ctx| is AEAD cipher context object which must be initialized
 * with a decryption key.  |iv| is IV of length |ivlen|.  |hp_ctx| is
 * a packet header protection cipher context object.
 *
 * |ivlen| must be the minimum length of AEAD nonce, or 8 bytes if
 * that is larger.
 *
 * If this function succeeds, |conn| takes ownership of |aead_ctx|,
 * and |hp_ctx|.  :member:`ngtcp2_callbacks.delete_crypto_aead_ctx`
 * and :member:`ngtcp2_callbacks.delete_crypto_cipher_ctx` will be
 * called to delete these objects when they are no longer used.  If
 * this function fails, the caller is responsible to delete them.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_install_rx_handshake_key(
  ngtcp2_conn *conn, const ngtcp2_crypto_aead_ctx *aead_ctx, const uint8_t *iv,
  size_t ivlen, const ngtcp2_crypto_cipher_ctx *hp_ctx);

/**
 * @function
 *
 * `ngtcp2_conn_install_tx_handshake_key` installs packet protection
 * keying materials for encrypting outgoing Handshake packets.
 * |aead_ctx| is AEAD cipher context object which must be initialized
 * with an encryption key.  |iv| is IV of length |ivlen|.  |hp_ctx| is
 * a packet header protection cipher context object.
 *
 * |ivlen| must be the minimum length of AEAD nonce, or 8 bytes if
 * that is larger.
 *
 * If this function succeeds, |conn| takes ownership of |aead_ctx| and
 * |hp_ctx|.  :member:`ngtcp2_callbacks.delete_crypto_aead_ctx` and
 * :member:`ngtcp2_callbacks.delete_crypto_cipher_ctx` will be called
 * to delete these objects when they are no longer used.  If this
 * function fails, the caller is responsible to delete them.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_install_tx_handshake_key(
  ngtcp2_conn *conn, const ngtcp2_crypto_aead_ctx *aead_ctx, const uint8_t *iv,
  size_t ivlen, const ngtcp2_crypto_cipher_ctx *hp_ctx);

/**
 * @function
 *
 * `ngtcp2_conn_install_0rtt_key` installs packet protection AEAD
 * cipher context object |aead_ctx|, IV |iv| of length |ivlen|, and
 * packet header protection cipher context object |hp_ctx| to encrypt
 * (for client) or decrypt (for server) 0-RTT packets.
 *
 * |ivlen| must be the minimum length of AEAD nonce, or 8 bytes if
 * that is larger.
 *
 * If this function succeeds, |conn| takes ownership of |aead_ctx| and
 * |hp_ctx|.  :member:`ngtcp2_callbacks.delete_crypto_aead_ctx` and
 * :member:`ngtcp2_callbacks.delete_crypto_cipher_ctx` will be called
 * to delete these objects when they are no longer used.  If this
 * function fails, the caller is responsible to delete them.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_install_0rtt_key(
  ngtcp2_conn *conn, const ngtcp2_crypto_aead_ctx *aead_ctx, const uint8_t *iv,
  size_t ivlen, const ngtcp2_crypto_cipher_ctx *hp_ctx);

/**
 * @function
 *
 * `ngtcp2_conn_install_rx_key` installs packet protection keying
 * materials for decrypting 1-RTT packets.  |secret| of length
 * |secretlen| is the decryption secret which is used to derive keying
 * materials passed to this function.  |aead_ctx| is AEAD cipher
 * context object which must be initialized with a decryption key.
 * |iv| is IV of length |ivlen|.  |hp_ctx| is a packet header
 * protection cipher context object.
 *
 * |ivlen| must be the minimum length of AEAD nonce, or 8 bytes if
 * that is larger.
 *
 * If this function succeeds, |conn| takes ownership of |aead_ctx| and
 * |hp_ctx|.  :member:`ngtcp2_callbacks.delete_crypto_aead_ctx` and
 * :member:`ngtcp2_callbacks.delete_crypto_cipher_ctx` will be called
 * to delete these objects when they are no longer used.  If this
 * function fails, the caller is responsible to delete them.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_install_rx_key(
  ngtcp2_conn *conn, const uint8_t *secret, size_t secretlen,
  const ngtcp2_crypto_aead_ctx *aead_ctx, const uint8_t *iv, size_t ivlen,
  const ngtcp2_crypto_cipher_ctx *hp_ctx);

/**
 * @function
 *
 * `ngtcp2_conn_install_tx_key` installs packet protection keying
 * materials for encrypting 1-RTT packets.  |secret| of length
 * |secretlen| is the encryption secret which is used to derive keying
 * materials passed to this function.  |aead_ctx| is AEAD cipher
 * context object which must be initialized with an encryption key.
 * |iv| is IV of length |ivlen|.  |hp_ctx| is a packet header
 * protection cipher context object.
 *
 * |ivlen| must be the minimum length of AEAD nonce, or 8 bytes if
 * that is larger.
 *
 * If this function succeeds, |conn| takes ownership of |aead_ctx| and
 * |hp_ctx|.  :member:`ngtcp2_callbacks.delete_crypto_aead_ctx` and
 * :member:`ngtcp2_callbacks.delete_crypto_cipher_ctx` will be called
 * to delete these objects when they are no longer used.  If this
 * function fails, the caller is responsible to delete them.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_install_tx_key(
  ngtcp2_conn *conn, const uint8_t *secret, size_t secretlen,
  const ngtcp2_crypto_aead_ctx *aead_ctx, const uint8_t *iv, size_t ivlen,
  const ngtcp2_crypto_cipher_ctx *hp_ctx);

/**
 * @function
 *
 * `ngtcp2_conn_initiate_key_update` initiates the key update.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_INVALID_STATE`
 *     The previous key update has not been confirmed yet; or key
 *     update is too frequent; or new keys are not available yet.
 */
NGTCP2_EXTERN int ngtcp2_conn_initiate_key_update(ngtcp2_conn *conn,
                                                  ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_set_tls_error` sets the TLS related error |liberr| in
 * |conn|.  |liberr| must be one of ngtcp2 library error codes (which
 * is defined as NGTCP2_ERR_* macro, such as
 * :macro:`NGTCP2_ERR_DECRYPT`).  In general, error code should be
 * propagated via return value, but sometimes ngtcp2 API is called
 * inside callback function of TLS stack, and it does not allow to
 * return ngtcp2 error code directly.  In this case, implementation
 * can set the error code (e.g.,
 * :macro:`NGTCP2_ERR_MALFORMED_TRANSPORT_PARAM`) using this function.
 *
 * See also `ngtcp2_conn_get_tls_error`.
 */
NGTCP2_EXTERN void ngtcp2_conn_set_tls_error(ngtcp2_conn *conn, int liberr);

/**
 * @function
 *
 * `ngtcp2_conn_get_tls_error` returns the value set by
 * `ngtcp2_conn_set_tls_error`.  If no value is set, this function
 * returns 0.
 */
NGTCP2_EXTERN int ngtcp2_conn_get_tls_error(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_set_tls_alert` sets a TLS alert |alert| generated by a
 * TLS stack of a local endpoint to |conn|.
 *
 * See also `ngtcp2_conn_get_tls_alert`.
 */
NGTCP2_EXTERN void ngtcp2_conn_set_tls_alert(ngtcp2_conn *conn, uint8_t alert);

/**
 * @function
 *
 * `ngtcp2_conn_get_tls_alert` returns the value set by
 * `ngtcp2_conn_set_tls_alert`.  If no value is set, this function
 * returns 0.
 */
NGTCP2_EXTERN uint8_t ngtcp2_conn_get_tls_alert(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_set_keep_alive_timeout` sets keep-alive timeout.  If
 * nonzero value is given, after a connection is idle at least in a
 * given amount of time, a keep-alive packet is sent.  If UINT64_MAX
 * is set, keep-alive functionality is disabled, and this is the
 * default.  Specifying 0 in |timeout| is reserved for a future
 * extension, and for now it is treated as if UINT64_MAX is given.
 */
NGTCP2_EXTERN void ngtcp2_conn_set_keep_alive_timeout(ngtcp2_conn *conn,
                                                      ngtcp2_duration timeout);

/**
 * @function
 *
 * `ngtcp2_conn_get_expiry` returns the next expiry time.  It returns
 * ``UINT64_MAX`` if there is no next expiry.
 *
 * Call `ngtcp2_conn_handle_expiry` when the expiry time has passed.
 */
NGTCP2_EXTERN ngtcp2_tstamp ngtcp2_conn_get_expiry(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_handle_expiry` handles expired timer.
 *
 * If it returns :macro:`NGTCP2_ERR_IDLE_CLOSE`, it means that an idle
 * timer has fired for this particular connection.  In this case, drop
 * the connection without calling
 * `ngtcp2_conn_write_connection_close`.  If it returns any of the
 * other negative error codes, close the connection by sending the
 * terminal packet produced by `ngtcp2_conn_write_connection_close`.
 * Otherwise, schedule `ngtcp2_conn_writev_stream` call.  An
 * application may call any number of additional
 * `ngtcp2_conn_read_pkt` and `ngtcp2_conn_handle_expiry` before
 * calling `ngtcp2_conn_writev_stream`.  After calling
 * `ngtcp2_conn_writev_stream`, new expiry is set.  The application
 * should call `ngtcp2_conn_get_expiry` to get a new deadline and set
 * the timer.
 */
NGTCP2_EXTERN int ngtcp2_conn_handle_expiry(ngtcp2_conn *conn,
                                            ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_get_pto` returns Probe Timeout (PTO).
 */
NGTCP2_EXTERN ngtcp2_duration ngtcp2_conn_get_pto(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_decode_and_set_remote_transport_params` decodes QUIC
 * transport parameters from the buffer pointed by |data| of length
 * |datalen|, and sets the result to |conn|.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_REQUIRED_TRANSPORT_PARAM`
 *     The required parameter is missing.
 * :macro:`NGTCP2_ERR_MALFORMED_TRANSPORT_PARAM`
 *     The input is malformed.
 * :macro:`NGTCP2_ERR_TRANSPORT_PARAM`
 *     Failed to validate the remote QUIC transport parameters.
 * :macro:`NGTCP2_ERR_VERSION_NEGOTIATION_FAILURE`
 *     Version negotiation failure.
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`
 *     User callback failed
 */
NGTCP2_EXTERN int ngtcp2_conn_decode_and_set_remote_transport_params(
  ngtcp2_conn *conn, const uint8_t *data, size_t datalen);

/**
 * @function
 *
 * `ngtcp2_conn_get_remote_transport_params` returns a pointer to the
 * remote QUIC transport parameters.  If no remote transport
 * parameters are set, it returns NULL.
 */
NGTCP2_EXTERN const ngtcp2_transport_params *
ngtcp2_conn_get_remote_transport_params(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_encode_0rtt_transport_params` encodes the QUIC
 * transport parameters that are used for 0-RTT data in the buffer
 * pointed by |dest| of length |destlen|.  It includes at least the
 * following fields:
 *
 * - :member:`ngtcp2_transport_params.initial_max_streams_bidi`
 * - :member:`ngtcp2_transport_params.initial_max_streams_uni`
 * - :member:`ngtcp2_transport_params.initial_max_stream_data_bidi_local`
 * - :member:`ngtcp2_transport_params.initial_max_stream_data_bidi_remote`
 * - :member:`ngtcp2_transport_params.initial_max_stream_data_uni`
 * - :member:`ngtcp2_transport_params.initial_max_data`
 * - :member:`ngtcp2_transport_params.active_connection_id_limit`
 * - :member:`ngtcp2_transport_params.max_datagram_frame_size`
 *
 * If |conn| is initialized as server, the following additional fields
 * are also included:
 *
 * - :member:`ngtcp2_transport_params.max_idle_timeout`
 * - :member:`ngtcp2_transport_params.max_udp_payload_size`
 * - :member:`ngtcp2_transport_params.disable_active_migration`
 *
 * If |conn| is initialized as client, these parameters are
 * synthesized from the remote transport parameters received from
 * server.  Otherwise, it is the local transport parameters that are
 * set by the local endpoint.
 *
 * This function returns the number of bytes written, or one of the
 * following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small.
 */
NGTCP2_EXTERN
ngtcp2_ssize ngtcp2_conn_encode_0rtt_transport_params(ngtcp2_conn *conn,
                                                      uint8_t *dest,
                                                      size_t destlen);

/**
 * @function
 *
 * `ngtcp2_conn_decode_and_set_0rtt_transport_params` decodes QUIC
 * transport parameters from |data| of length |datalen|, which is
 * assumed to be the parameters received from the server in the
 * previous connection, and sets it to |conn|.  These parameters are
 * used to send 0-RTT data.  QUIC requires that client application
 * should remember transport parameters along with a session ticket.
 *
 * At least following fields should be included:
 *
 * - :member:`ngtcp2_transport_params.initial_max_streams_bidi`
 * - :member:`ngtcp2_transport_params.initial_max_streams_uni`
 * - :member:`ngtcp2_transport_params.initial_max_stream_data_bidi_local`
 * - :member:`ngtcp2_transport_params.initial_max_stream_data_bidi_remote`
 * - :member:`ngtcp2_transport_params.initial_max_stream_data_uni`
 * - :member:`ngtcp2_transport_params.initial_max_data`
 * - :member:`ngtcp2_transport_params.active_connection_id_limit`
 * - :member:`ngtcp2_transport_params.max_datagram_frame_size` (if
 *   DATAGRAM extension was negotiated)
 *
 * This function must only be used by client.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 * :macro:`NGTCP2_ERR_MALFORMED_TRANSPORT_PARAM`
 *     The input is malformed.
 */
NGTCP2_EXTERN int ngtcp2_conn_decode_and_set_0rtt_transport_params(
  ngtcp2_conn *conn, const uint8_t *data, size_t datalen);

/**
 * @function
 *
 * `ngtcp2_conn_set_local_transport_params` sets the local transport
 * parameters |params|.  This function can only be called by server.
 * Although the local transport parameters are passed to
 * `ngtcp2_conn_server_new`, server might want to update them after
 * ALPN is chosen.  In that case, server can update the transport
 * parameters with this function.  Server must call this function
 * before calling `ngtcp2_conn_install_tx_handshake_key`.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_INVALID_STATE`
 *     `ngtcp2_conn_install_tx_handshake_key` has been called.
 */
NGTCP2_EXTERN int ngtcp2_conn_set_local_transport_params_versioned(
  ngtcp2_conn *conn, int transport_params_version,
  const ngtcp2_transport_params *params);

/**
 * @function
 *
 * `ngtcp2_conn_get_local_transport_params` returns a pointer to the
 * local QUIC transport parameters.
 */
NGTCP2_EXTERN const ngtcp2_transport_params *
ngtcp2_conn_get_local_transport_params(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_encode_local_transport_params` encodes the local QUIC
 * transport parameters in |dest| of length |destlen|.
 *
 * This function returns the number of bytes written, or one of the
 * following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_encode_local_transport_params(
  ngtcp2_conn *conn, uint8_t *dest, size_t destlen);

/**
 * @function
 *
 * `ngtcp2_conn_open_bidi_stream` opens new bidirectional stream.  The
 * |stream_user_data| is the user data specific to the stream.  The
 * stream ID of the opened stream is stored in |*pstream_id|.
 *
 * Application can call this function before handshake completes.  For
 * 0-RTT packet, application can call this function after calling
 * `ngtcp2_conn_decode_and_set_0rtt_transport_params`.  For 1-RTT
 * packet, application can call this function after calling
 * `ngtcp2_conn_decode_and_set_remote_transport_params` and
 * `ngtcp2_conn_install_tx_key`.  If ngtcp2 crypto support library is
 * used, application can call this function after calling
 * `ngtcp2_crypto_derive_and_install_tx_key` for 1-RTT packet.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 * :macro:`NGTCP2_ERR_STREAM_ID_BLOCKED`
 *     The remote endpoint does not allow |stream_id| yet.
 */
NGTCP2_EXTERN int ngtcp2_conn_open_bidi_stream(ngtcp2_conn *conn,
                                               int64_t *pstream_id,
                                               void *stream_user_data);

/**
 * @function
 *
 * `ngtcp2_conn_open_uni_stream` opens new unidirectional stream.  The
 * |stream_user_data| is the user data specific to the stream.  The
 * stream ID of the opened stream is stored in |*pstream_id|.
 *
 * Application can call this function before handshake completes.  For
 * 0-RTT packet, application can call this function after calling
 * `ngtcp2_conn_decode_and_set_0rtt_transport_params`.  For 1-RTT
 * packet, application can call this function after calling
 * `ngtcp2_conn_decode_and_set_remote_transport_params` and
 * `ngtcp2_conn_install_tx_key`.  If ngtcp2 crypto support library is
 * used, application can call this function after calling
 * `ngtcp2_crypto_derive_and_install_tx_key` for 1-RTT packet.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 * :macro:`NGTCP2_ERR_STREAM_ID_BLOCKED`
 *     The remote endpoint does not allow |stream_id| yet.
 */
NGTCP2_EXTERN int ngtcp2_conn_open_uni_stream(ngtcp2_conn *conn,
                                              int64_t *pstream_id,
                                              void *stream_user_data);

/**
 * @function
 *
 * `ngtcp2_conn_shutdown_stream` closes a stream denoted by
 * |stream_id| abruptly.  |app_error_code| is one of application error
 * codes, and indicates the reason of shutdown.  Successful call of
 * this function does not immediately erase the state of the stream.
 * The actual deletion is done when the remote endpoint sends
 * acknowledgement.  Calling this function is equivalent to call
 * `ngtcp2_conn_shutdown_stream_read`, and
 * `ngtcp2_conn_shutdown_stream_write` sequentially with the following
 * differences.  If |stream_id| refers to a local unidirectional
 * stream, this function only shutdowns write side of the stream.  If
 * |stream_id| refers to a remote unidirectional stream, this function
 * only shutdowns read side of the stream.
 *
 * |flags| is currently unused, and should be set to 0.
 *
 * This function returns 0 if a stream denoted by |stream_id| is not
 * found.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 */
NGTCP2_EXTERN int ngtcp2_conn_shutdown_stream(ngtcp2_conn *conn, uint32_t flags,
                                              int64_t stream_id,
                                              uint64_t app_error_code);

/**
 * @function
 *
 * `ngtcp2_conn_shutdown_stream_write` closes write-side of a stream
 * denoted by |stream_id| abruptly.  |app_error_code| is one of
 * application error codes, and indicates the reason of shutdown.  If
 * this function succeeds, no further application data is sent to the
 * remote endpoint.  It discards all data which has not been
 * acknowledged yet.
 *
 * |flags| is currently unused, and should be set to 0.
 *
 * This function returns 0 if a stream denoted by |stream_id| is not
 * found.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     |stream_id| refers to a remote unidirectional stream.
 */
NGTCP2_EXTERN int ngtcp2_conn_shutdown_stream_write(ngtcp2_conn *conn,
                                                    uint32_t flags,
                                                    int64_t stream_id,
                                                    uint64_t app_error_code);

/**
 * @function
 *
 * `ngtcp2_conn_shutdown_stream_read` closes read-side of a stream
 * denoted by |stream_id| abruptly.  |app_error_code| is one of
 * application error codes, and indicates the reason of shutdown.  If
 * this function succeeds, no further application data is forwarded to
 * an application layer.
 *
 * |flags| is currently unused, and should be set to 0.
 *
 * This function returns 0 if a stream denoted by |stream_id| is not
 * found.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     |stream_id| refers to a local unidirectional stream.
 */
NGTCP2_EXTERN int ngtcp2_conn_shutdown_stream_read(ngtcp2_conn *conn,
                                                   uint32_t flags,
                                                   int64_t stream_id,
                                                   uint64_t app_error_code);

/**
 * @macrosection
 *
 * Write stream data flags
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_WRITE_STREAM_FLAG_NONE` indicates no flag set.
 */
#define NGTCP2_WRITE_STREAM_FLAG_NONE 0x00U

/**
 * @macro
 *
 * :macro:`NGTCP2_WRITE_STREAM_FLAG_MORE` indicates that more data may
 * come, and should be coalesced into the same packet if possible.
 */
#define NGTCP2_WRITE_STREAM_FLAG_MORE 0x01U

/**
 * @macro
 *
 * :macro:`NGTCP2_WRITE_STREAM_FLAG_FIN` indicates that a passed data
 * is the final part of a stream.
 */
#define NGTCP2_WRITE_STREAM_FLAG_FIN 0x02U

/**
 * @macro
 *
 * :macro:`NGTCP2_WRITE_STREAM_FLAG_PADDING` indicates that a
 * non-empty 0 RTT or 1 RTT ack-eliciting packet is padded to the
 * minimum length of a sending path MTU or a given packet buffer when
 * finalizing it.  PATH_CHALLENGE, PATH_RESPONSE, CONNECTION_CLOSE
 * only packets and PMTUD packets are excluded.
 */
#define NGTCP2_WRITE_STREAM_FLAG_PADDING 0x04U

/**
 * @function
 *
 * `ngtcp2_conn_write_stream` is just like
 * `ngtcp2_conn_writev_stream`.  The only difference is that it
 * conveniently accepts a single buffer.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_write_stream_versioned(
  ngtcp2_conn *conn, ngtcp2_path *path, int pkt_info_version,
  ngtcp2_pkt_info *pi, uint8_t *dest, size_t destlen, ngtcp2_ssize *pdatalen,
  uint32_t flags, int64_t stream_id, const uint8_t *data, size_t datalen,
  ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_writev_stream` writes a packet containing stream data
 * of a stream denoted by |stream_id|.  The buffer of the packet is
 * pointed by |dest| of length |destlen|.  This function performs QUIC
 * handshake as well.
 *
 * |destlen| should be at least
 * :member:`ngtcp2_settings.max_tx_udp_payload_size`.  It must be at
 * least :macro:`NGTCP2_MAX_UDP_PAYLOAD_SIZE`.
 *
 * Specifying -1 to |stream_id| means no new stream data to send.
 *
 * If |path| is not ``NULL``, this function stores the network path
 * with which the packet should be sent.  Each addr field
 * (:member:`ngtcp2_path.local` and :member:`ngtcp2_path.remote`) must
 * point to the buffer which should be at least
 * sizeof(:type:`sockaddr_union`) bytes long.  The assignment might
 * not be done if nothing is written to |dest|.
 *
 * If |pi| is not ``NULL``, this function stores packet metadata in it
 * if it succeeds.  The metadata includes ECN markings.  When calling
 * this function again after it returns
 * :macro:`NGTCP2_ERR_WRITE_MORE`, caller must pass the same |pi| to
 * this function.
 *
 * Stream data is specified as vector of data |datav|.  |datavcnt|
 * specifies the number of :type:`ngtcp2_vec` that |datav| includes.
 *
 * If all given data is encoded as STREAM frame in |dest|, and if
 * |flags| & :macro:`NGTCP2_WRITE_STREAM_FLAG_FIN` is nonzero, fin
 * flag is set to outgoing STREAM frame.  Otherwise, fin flag in
 * STREAM frame is not set.
 *
 * This packet may contain frames other than STREAM frame.  The packet
 * might not contain STREAM frame if other frames occupy the packet.
 * In that case, |*pdatalen| would be -1 if |pdatalen| is not
 * ``NULL``.
 *
 * Empty data is treated specially, and it is only accepted if no
 * data, including the empty data, is submitted to a stream or
 * :macro:`NGTCP2_WRITE_STREAM_FLAG_FIN` is set in |flags|.  If 0
 * length STREAM frame is successfully serialized, |*pdatalen| would
 * be 0.
 *
 * The number of data encoded in STREAM frame is stored in |*pdatalen|
 * if it is not ``NULL``.  The caller must keep the portion of data
 * covered by |*pdatalen| bytes in tact until
 * :member:`ngtcp2_callbacks.acked_stream_data_offset` indicates that
 * they are acknowledged by a remote endpoint or the stream is closed.
 *
 * If the given stream data is small (e.g., few bytes), the packet
 * might be severely under filled.  Too many small packet might
 * increase overall packet processing costs.  Unless there are
 * retransmissions, by default, application can only send 1 STREAM
 * frame in one QUIC packet.  In order to include more than 1 STREAM
 * frame in one QUIC packet, specify
 * :macro:`NGTCP2_WRITE_STREAM_FLAG_MORE` in |flags|.  This is
 * analogous to ``MSG_MORE`` flag in :manpage:`send(2)`.  If the
 * :macro:`NGTCP2_WRITE_STREAM_FLAG_MORE` is used, there are 4
 * outcomes:
 *
 * - The function returns the written length of packet just like
 *   without :macro:`NGTCP2_WRITE_STREAM_FLAG_MORE`.  This is because
 *   packet is nearly full, and the library decided to make a complete
 *   packet.  |*pdatalen| might be -1 or >= 0.  It may return 0 which
 *   indicates that no packet transmission is possible at the moment
 *   for some reason.
 *
 * - The function returns :macro:`NGTCP2_ERR_WRITE_MORE`.  In this
 *   case, |*pdatalen| >= 0 is asserted.  It indicates that
 *   application can still call this function with different stream
 *   data (or `ngtcp2_conn_writev_datagram` if it has data to send in
 *   unreliable datagram) to pack them into the same packet.
 *   Application has to specify the same |conn|, |path|, |pi|, |dest|,
 *   |destlen|, and |ts| parameters, otherwise the behaviour is
 *   undefined.  The application can change |flags|.
 *
 * - The function returns one of the following negative error codes:
 *   :macro:`NGTCP2_ERR_STREAM_DATA_BLOCKED`,
 *   :macro:`NGTCP2_ERR_STREAM_NOT_FOUND`, or
 *   :macro:`NGTCP2_ERR_STREAM_SHUT_WR`.  In this case, |*pdatalen| ==
 *   -1 is asserted.  Application can still write the stream data of
 *   the other streams by calling this function (or
 *   `ngtcp2_conn_writev_datagram` if it has data to send in
 *   unreliable datagram) to pack them into the same packet.
 *   Application has to specify the same |conn|, |path|, |pi|, |dest|,
 *   |destlen|, and |ts| parameters, otherwise the behaviour is
 *   undefined.  The application can change |flags|.
 *
 * - The other negative error codes might be returned just like
 *   without :macro:`NGTCP2_WRITE_STREAM_FLAG_MORE`.  These errors
 *   should be treated as a connection error.
 *
 * When application uses :macro:`NGTCP2_WRITE_STREAM_FLAG_MORE` at
 * least once, it must not call other ngtcp2 API functions
 * (application can still call `ngtcp2_conn_write_connection_close` to
 * handle error from this function.  It can also call
 * `ngtcp2_conn_shutdown_stream_read`,
 * `ngtcp2_conn_shutdown_stream_write`, and
 * `ngtcp2_conn_shutdown_stream`), just keep calling this function (or
 * `ngtcp2_conn_writev_datagram`) until it returns 0, a positive
 * number (which indicates a complete packet is ready), or the error
 * codes other than :macro:`NGTCP2_ERR_WRITE_MORE`,
 * :macro:`NGTCP2_ERR_STREAM_DATA_BLOCKED`,
 * :macro:`NGTCP2_ERR_STREAM_NOT_FOUND`, and
 * :macro:`NGTCP2_ERR_STREAM_SHUT_WR`.  If there is no stream data to
 * include, call this function with |stream_id| as -1 to stop
 * coalescing and write a packet.
 *
 * If :macro:`NGTCP2_WRITE_STREAM_FLAG_PADDING` is set in |flags| when
 * finalizing a non-empty 0 RTT or 1 RTT ack-eliciting packet, the
 * packet is padded to the minimum length of a sending path MTU or a
 * given packet buffer.
 *
 * This function returns 0 if it cannot write any frame because buffer
 * is too small, or packet is congestion limited.  Application should
 * keep reading and wait for congestion window to grow.
 *
 * This function must not be called from inside the callback
 * functions.
 *
 * `ngtcp2_conn_update_pkt_tx_time` must be called after this
 * function.  Application may call this function multiple times before
 * calling `ngtcp2_conn_update_pkt_tx_time`.
 *
 * This function returns the number of bytes written in |dest| if it
 * succeeds, or one of the following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 * :macro:`NGTCP2_ERR_STREAM_NOT_FOUND`
 *     Stream does not exist
 * :macro:`NGTCP2_ERR_STREAM_SHUT_WR`
 *     Stream is half closed (local); or stream is being reset.
 * :macro:`NGTCP2_ERR_PKT_NUM_EXHAUSTED`
 *     Packet number is exhausted, and cannot send any more packet.
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`
 *     User callback failed
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     The total length of stream data is too large.
 * :macro:`NGTCP2_ERR_STREAM_DATA_BLOCKED`
 *     Stream is blocked because of flow control.
 * :macro:`NGTCP2_ERR_WRITE_MORE`
 *     (Only when :macro:`NGTCP2_WRITE_STREAM_FLAG_MORE` is specified)
 *     Application can call this function to pack more stream data
 *     into the same packet.  See above to know how it works.
 *
 * If any other negative error is returned, call
 * `ngtcp2_conn_write_connection_close` to get terminal packet, and
 * sending it makes QUIC connection enter the closing state.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_writev_stream_versioned(
  ngtcp2_conn *conn, ngtcp2_path *path, int pkt_info_version,
  ngtcp2_pkt_info *pi, uint8_t *dest, size_t destlen, ngtcp2_ssize *pdatalen,
  uint32_t flags, int64_t stream_id, const ngtcp2_vec *datav, size_t datavcnt,
  ngtcp2_tstamp ts);

/**
 * @macrosection
 *
 * Write datagram flags
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_NONE` indicates no flag set.
 */
#define NGTCP2_WRITE_DATAGRAM_FLAG_NONE 0x00U

/**
 * @macro
 *
 * :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_MORE` indicates that more data
 * may come, and should be coalesced into the same packet if possible.
 */
#define NGTCP2_WRITE_DATAGRAM_FLAG_MORE 0x01U

/**
 * @macro
 *
 * :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_PADDING` indicates that a
 * non-empty 0 RTT or 1 RTT ack-eliciting packet is padded to the
 * minimum length of a sending path MTU or a given packet buffer when
 * finalizing it.  PATH_CHALLENGE, PATH_RESPONSE, CONNECTION_CLOSE
 * only packets and PMTUD packets are excluded.
 */
#define NGTCP2_WRITE_DATAGRAM_FLAG_PADDING 0x02U

/**
 * @function
 *
 * `ngtcp2_conn_write_datagram` is just like
 * `ngtcp2_conn_writev_datagram`.  The only difference is that it
 * conveniently accepts a single buffer.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_write_datagram_versioned(
  ngtcp2_conn *conn, ngtcp2_path *path, int pkt_info_version,
  ngtcp2_pkt_info *pi, uint8_t *dest, size_t destlen, int *paccepted,
  uint32_t flags, uint64_t dgram_id, const uint8_t *data, size_t datalen,
  ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_writev_datagram` writes a packet containing unreliable
 * data in DATAGRAM frame.  The buffer of the packet is pointed by
 * |dest| of length |destlen|.  This function performs QUIC handshake
 * as well.
 *
 * |destlen| should be at least
 * :member:`ngtcp2_settings.max_tx_udp_payload_size`.  It must be at
 * least :macro:`NGTCP2_MAX_UDP_PAYLOAD_SIZE`.
 *
 * For |path| and |pi| parameters, refer to
 * `ngtcp2_conn_writev_stream`.
 *
 * Stream data is specified as vector of data |datav|.  |datavcnt|
 * specifies the number of :type:`ngtcp2_vec` that |datav| includes.
 *
 * If the given data is written to the buffer, nonzero value is
 * assigned to |*paccepted| if it is not NULL.  The data in DATAGRAM
 * frame cannot be fragmented; writing partial data is not possible.
 *
 * |dgram_id| is an opaque identifier which should uniquely identify
 * the given DATAGRAM data.  It is passed to
 * :member:`ngtcp2_callbacks.ack_datagram` callback when a packet that
 * contains DATAGRAM frame is acknowledged.  It is also passed to
 * :member:`ngtcp2_callbacks.lost_datagram` callback when a packet
 * that contains DATAGRAM frame is declared lost.  If an application
 * uses neither of those callbacks, it can sets 0 to this parameter.
 *
 * This function might write other frames other than DATAGRAM frame,
 * just like `ngtcp2_conn_writev_stream`.
 *
 * If the function returns 0, it means that no more data cannot be
 * sent because of congestion control limit; or, data does not fit
 * into the provided buffer; or, a local endpoint, as a server, is
 * unable to send data because of its amplification limit.  In this
 * case, |*paccepted| is assigned zero if it is not NULL.
 *
 * If :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_MORE` is set in |flags|,
 * there are 3 outcomes:
 *
 * - The function returns the written length of packet just like
 *   without :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_MORE`.  This is
 *   because packet is nearly full and the library decided to make a
 *   complete packet.  |*paccepted| might be zero or nonzero.
 *
 * - The function returns :macro:`NGTCP2_ERR_WRITE_MORE`.  In this
 *   case, |*paccepted| != 0 is asserted.  This indicates that
 *   application can call this function with another unreliable data
 *   (or `ngtcp2_conn_writev_stream` if it has stream data to send) to
 *   pack them into the same packet.  Application has to specify the
 *   same |conn|, |path|, |pi|, |dest|, |destlen|, and |ts|
 *   parameters, otherwise the behaviour is undefined.  The
 *   application can change |flags|.
 *
 * - The other error might be returned just like without
 *   :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_MORE`.
 *
 * When application sees :macro:`NGTCP2_ERR_WRITE_MORE`, it must not
 * call other ngtcp2 API functions (application can still call
 * `ngtcp2_conn_write_connection_close` to handle error from this
 * function.  It can also call `ngtcp2_conn_shutdown_stream_read`,
 * `ngtcp2_conn_shutdown_stream_write`, and
 * `ngtcp2_conn_shutdown_stream`).  Just keep calling this function
 * (or `ngtcp2_conn_writev_stream`) until it returns a positive number
 * (which indicates a complete packet is ready).
 *
 * If :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_PADDING` is set in |flags|
 * when finalizing a non-empty 0 RTT or 1 RTT ack-eliciting packet,
 * the packet is padded to the minimum length of a sending path MTU or
 * a given packet buffer.
 *
 * This function returns the number of bytes written in |dest| if it
 * succeeds, or one of the following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 * :macro:`NGTCP2_ERR_PKT_NUM_EXHAUSTED`
 *     Packet number is exhausted, and cannot send any more packet.
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`
 *     User callback failed
 * :macro:`NGTCP2_ERR_WRITE_MORE`
 *     (Only when :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_MORE` is
 *     specified) Application can call this function to pack more data
 *     into the same packet.  See above to know how it works.
 * :macro:`NGTCP2_ERR_INVALID_STATE`
 *     A remote endpoint did not express the DATAGRAM frame support.
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     The provisional DATAGRAM frame size exceeds the maximum
 *     DATAGRAM frame size that a remote endpoint can receive.
 *
 * If any other negative error is returned, call
 * `ngtcp2_conn_write_connection_close` to get terminal packet, and
 * sending it makes QUIC connection enter the closing state.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_writev_datagram_versioned(
  ngtcp2_conn *conn, ngtcp2_path *path, int pkt_info_version,
  ngtcp2_pkt_info *pi, uint8_t *dest, size_t destlen, int *paccepted,
  uint32_t flags, uint64_t dgram_id, const ngtcp2_vec *datav, size_t datavcnt,
  ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_in_closing_period` returns nonzero if |conn| is in the
 * closing period.
 */
NGTCP2_EXTERN int ngtcp2_conn_in_closing_period(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_in_draining_period` returns nonzero if |conn| is in
 * the draining period.
 */
NGTCP2_EXTERN int ngtcp2_conn_in_draining_period(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_extend_max_stream_offset` extends the maximum stream
 * data that a remote endpoint can send by |datalen|.  |stream_id|
 * specifies the stream ID.  This function only extends stream-level
 * flow control window.
 *
 * This function returns 0 if a stream denoted by |stream_id| is not
 * found.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     |stream_id| refers to a local unidirectional stream.
 */
NGTCP2_EXTERN int ngtcp2_conn_extend_max_stream_offset(ngtcp2_conn *conn,
                                                       int64_t stream_id,
                                                       uint64_t datalen);

/**
 * @function
 *
 * `ngtcp2_conn_extend_max_offset` extends max data offset by
 * |datalen|.  This function only extends connection-level flow
 * control window.
 */
NGTCP2_EXTERN void ngtcp2_conn_extend_max_offset(ngtcp2_conn *conn,
                                                 uint64_t datalen);

/**
 * @function
 *
 * `ngtcp2_conn_extend_max_streams_bidi` extends the number of maximum
 * remote bidirectional streams that a remote endpoint can open by
 * |n|.
 *
 * The library does not increase maximum stream limit automatically.
 * The exception is when a stream is closed without
 * :member:`ngtcp2_callbacks.stream_open` callback being called.  In
 * this case, stream limit is increased automatically.
 */
NGTCP2_EXTERN void ngtcp2_conn_extend_max_streams_bidi(ngtcp2_conn *conn,
                                                       size_t n);

/**
 * @function
 *
 * `ngtcp2_conn_extend_max_streams_uni` extends the number of maximum
 * remote unidirectional streams that a remote endpoint can open by
 * |n|.
 *
 * The library does not increase maximum stream limit automatically.
 * The exception is when a stream is closed without
 * :member:`ngtcp2_callbacks.stream_open` callback being called.  In
 * this case, stream limit is increased automatically.
 */
NGTCP2_EXTERN void ngtcp2_conn_extend_max_streams_uni(ngtcp2_conn *conn,
                                                      size_t n);

/**
 * @function
 *
 * `ngtcp2_conn_get_dcid` returns the non-NULL pointer to the current
 * Destination Connection ID.  If no Destination Connection ID is
 * present, the return value is not ``NULL``, and its :member:`datalen
 * <ngtcp2_cid.datalen>` field is 0.
 */
NGTCP2_EXTERN const ngtcp2_cid *ngtcp2_conn_get_dcid(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_client_initial_dcid` returns the non-NULL pointer
 * to the Destination Connection ID that client sent in its Initial
 * packet.  If the Destination Connection ID is not present, the
 * return value is not ``NULL``, and its :member:`datalen
 * <ngtcp2_cid.datalen>` field is 0.
 */
NGTCP2_EXTERN const ngtcp2_cid *
ngtcp2_conn_get_client_initial_dcid(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_scid` writes the all Source Connection IDs which a
 * local endpoint has provided to a remote endpoint, and are not
 * retired in |dest|.  If |dest| is NULL, this function does not write
 * anything, and returns the number of Source Connection IDs that
 * would otherwise be written to the provided buffer.  The buffer
 * pointed by |dest| must have sizeof(:type:`ngtcp2_cid`) * n bytes
 * available, where n is the return value of `ngtcp2_conn_get_scid`
 * with |dest| == NULL.
 */
NGTCP2_EXTERN size_t ngtcp2_conn_get_scid(ngtcp2_conn *conn, ngtcp2_cid *dest);

/**
 * @struct
 *
 * :type:`ngtcp2_cid_token` is the convenient struct to store
 * Connection ID, its associated path, and stateless reset token.
 *
 * Deprecated since v1.22.0.  Use :type:`ngtcp2_cid_token2` instead.
 */
typedef struct ngtcp2_cid_token {
  /**
   * :member:`seq` is the sequence number of this Connection ID.
   */
  uint64_t seq;
  /**
   * :member:`cid` is Connection ID.
   */
  ngtcp2_cid cid;
  /**
   * :member:`ps` is the path which this Connection ID is associated
   * with.
   */
  ngtcp2_path_storage ps;
  /**
   * :member:`token` is the stateless reset token for this Connection
   * ID.
   */
  uint8_t token[NGTCP2_STATELESS_RESET_TOKENLEN];
  /**
   * :member:`token_present` is nonzero if token contains stateless
   * reset token.
   */
  uint8_t token_present;
} ngtcp2_cid_token;

/**
 * @function
 *
 * `ngtcp2_conn_get_active_dcid` writes the all active Destination
 * Connection IDs and their tokens to |dest|.  Before handshake
 * completes, this function returns 0.  If |dest| is NULL, this
 * function does not write anything, and returns the number of
 * Destination Connection IDs that would otherwise be written to the
 * provided buffer.  The buffer pointed by |dest| must have
 * sizeof(:type:`ngtcp2_cid_token`) * n bytes available, where n is
 * the return value of `ngtcp2_conn_get_active_dcid` with |dest| ==
 * NULL.
 *
 * Deprecated since v1.22.0.  Use `ngtcp2_conn_get_active_dcid2`
 * instead.
 */
NGTCP2_EXTERN size_t ngtcp2_conn_get_active_dcid(ngtcp2_conn *conn,
                                                 ngtcp2_cid_token *dest);

/**
 * @struct
 *
 * :type:`ngtcp2_cid_token2` is the convenient struct to store
 * Connection ID, its associated path, and stateless reset token.
 *
 * This type has been available since v1.22.0.
 */
typedef struct ngtcp2_cid_token2 {
  /**
   * :member:`seq` is the sequence number of this Connection ID.
   */
  uint64_t seq;
  /**
   * :member:`cid` is Connection ID.
   */
  ngtcp2_cid cid;
  /**
   * :member:`ps` is the path which this Connection ID is associated
   * with.
   */
  ngtcp2_path_storage ps;
  /**
   * :member:`token` is the stateless reset token for this Connection
   * ID.
   */
  ngtcp2_stateless_reset_token token;
  /**
   * :member:`token_present` is nonzero if token contains stateless
   * reset token.
   */
  uint8_t token_present;
} ngtcp2_cid_token2;

/**
 * @function
 *
 * `ngtcp2_conn_get_active_dcid2` writes the all active Destination
 * Connection IDs and their tokens to |dest|.  Before handshake
 * completes, this function returns 0.  If |dest| is NULL, this
 * function does not write anything, and returns the number of
 * Destination Connection IDs that would otherwise be written to the
 * provided buffer.  The buffer pointed by |dest| must have
 * sizeof(:type:`ngtcp2_cid_token2`) * n bytes available, where n is
 * the return value of `ngtcp2_conn_get_active_dcid2` with |dest| ==
 * NULL.
 *
 * This function has been available since v1.22.0.
 */
NGTCP2_EXTERN size_t ngtcp2_conn_get_active_dcid2(ngtcp2_conn *conn,
                                                  ngtcp2_cid_token2 *dest);

/**
 * @function
 *
 * `ngtcp2_conn_get_client_chosen_version` returns the client chosen
 * version.
 */
NGTCP2_EXTERN uint32_t ngtcp2_conn_get_client_chosen_version(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_negotiated_version` returns the negotiated
 * version.
 *
 * Until the version is negotiated, this function returns 0.
 */
NGTCP2_EXTERN uint32_t ngtcp2_conn_get_negotiated_version(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_tls_early_data_rejected` tells |conn| that early data
 * was rejected by a server during TLS handshake, or client decided
 * not to attempt early data for some reason.  |conn| discards the
 * following connection states:
 *
 * - Any opened streams.
 * - Stream identifier allocations.
 * - Max data extended by `ngtcp2_conn_extend_max_offset`.
 * - Max bidi streams extended by `ngtcp2_conn_extend_max_streams_bidi`.
 * - Max uni streams extended by `ngtcp2_conn_extend_max_streams_uni`.
 *
 * Application which wishes to retransmit early data, it has to open
 * streams, and send stream data again.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`
 *     User callback failed
 */
NGTCP2_EXTERN int ngtcp2_conn_tls_early_data_rejected(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_tls_early_data_rejected` returns nonzero if
 * `ngtcp2_conn_tls_early_data_rejected` has been called.
 */
NGTCP2_EXTERN int ngtcp2_conn_get_tls_early_data_rejected(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_conn_info` assigns connection statistics data to
 * |*cinfo|.
 */
NGTCP2_EXTERN void ngtcp2_conn_get_conn_info_versioned(ngtcp2_conn *conn,
                                                       int conn_info_version,
                                                       ngtcp2_conn_info *cinfo);

/**
 * @function
 *
 * `ngtcp2_conn_submit_crypto_data` submits crypto data |data| of
 * length |datalen| to the library for transmission.
 * |encryption_level| specifies the encryption level of data.
 *
 * The library makes a copy of the buffer pointed by |data| of length
 * |datalen|.  Application can discard |data|.
 */
NGTCP2_EXTERN int
ngtcp2_conn_submit_crypto_data(ngtcp2_conn *conn,
                               ngtcp2_encryption_level encryption_level,
                               const uint8_t *data, const size_t datalen);

/**
 * @function
 *
 * `ngtcp2_conn_submit_new_token` submits address validation token.
 * It is sent in NEW_TOKEN frame.  Only server can call this function.
 * |tokenlen| must not be 0.
 *
 * This function makes a copy of the buffer pointed by |token| of
 * length |tokenlen|.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory.
 */
NGTCP2_EXTERN int ngtcp2_conn_submit_new_token(ngtcp2_conn *conn,
                                               const uint8_t *token,
                                               size_t tokenlen);

/**
 * @function
 *
 * `ngtcp2_conn_set_local_addr` sets local endpoint address |addr| to
 * the current path of |conn|.  This function is provided for testing
 * purpose only.
 */
NGTCP2_EXTERN void ngtcp2_conn_set_local_addr(ngtcp2_conn *conn,
                                              const ngtcp2_addr *addr);

/**
 * @function
 *
 * `ngtcp2_conn_set_path_user_data` sets the |path_user_data| to the
 * current path (see :member:`ngtcp2_path.user_data`).
 */
NGTCP2_EXTERN void ngtcp2_conn_set_path_user_data(ngtcp2_conn *conn,
                                                  void *path_user_data);

/**
 * @function
 *
 * `ngtcp2_conn_get_path` returns the current path.
 */
NGTCP2_EXTERN const ngtcp2_path *ngtcp2_conn_get_path(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_max_tx_udp_payload_size` returns the maximum UDP
 * payload size that this local endpoint would send.  This is the
 * value of :member:`ngtcp2_settings.max_tx_udp_payload_size` that is
 * passed to `ngtcp2_conn_client_new` or `ngtcp2_conn_server_new`.
 */
NGTCP2_EXTERN size_t ngtcp2_conn_get_max_tx_udp_payload_size(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_path_max_tx_udp_payload_size` returns the maximum
 * UDP payload size for the current path.  If
 * :member:`ngtcp2_settings.no_tx_udp_payload_size_shaping` is set to
 * nonzero, this function is equivalent to
 * `ngtcp2_conn_get_max_tx_udp_payload_size`.  Otherwise, it returns
 * the maximum UDP payload size that is probed for the current path.
 */
NGTCP2_EXTERN size_t
ngtcp2_conn_get_path_max_tx_udp_payload_size(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_initiate_immediate_migration` starts connection
 * migration to the given |path|.  Only client can initiate migration.
 * This function does immediate migration; while the path validation
 * is nonetheless performed, this function does not wait for it to
 * succeed.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_INVALID_STATE`
 *     Migration is disabled; or handshake is not yet confirmed; or
 *     client is migrating to server's preferred address.
 * :macro:`NGTCP2_ERR_CONN_ID_BLOCKED`
 *     No unused connection ID is available.
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     :member:`local <ngtcp2_path.local>` field of |path| equals the
 *     current local address.
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 */
NGTCP2_EXTERN int ngtcp2_conn_initiate_immediate_migration(
  ngtcp2_conn *conn, const ngtcp2_path *path, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_initiate_migration` starts connection migration to the
 * given |path|.  Only client can initiate migration.  Unlike
 * `ngtcp2_conn_initiate_immediate_migration`, this function starts a
 * path validation with a new path, and migrate to the new path after
 * successful path validation.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_INVALID_STATE`
 *     Migration is disabled; or handshake is not yet confirmed; or
 *     client is migrating to server's preferred address.
 * :macro:`NGTCP2_ERR_CONN_ID_BLOCKED`
 *     No unused connection ID is available.
 * :macro:`NGTCP2_ERR_INVALID_ARGUMENT`
 *     :member:`local <ngtcp2_path.local>` field of |path| equals the
 *     current local address.
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 */
NGTCP2_EXTERN int ngtcp2_conn_initiate_migration(ngtcp2_conn *conn,
                                                 const ngtcp2_path *path,
                                                 ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_get_max_data_left` returns the number of bytes that
 * this local endpoint can send in this connection without violating
 * connection-level flow control.
 */
NGTCP2_EXTERN uint64_t ngtcp2_conn_get_max_data_left(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_max_stream_data_left` returns the number of bytes
 * that this local endpoint can send to a stream identified by
 * |stream_id| without violating stream-level flow control.  If no
 * such stream is found, this function returns 0.
 */
NGTCP2_EXTERN uint64_t ngtcp2_conn_get_max_stream_data_left(ngtcp2_conn *conn,
                                                            int64_t stream_id);

/**
 * @function
 *
 * `ngtcp2_conn_get_streams_bidi_left` returns the number of
 * bidirectional streams which the local endpoint can open without
 * violating stream concurrency limit.
 */
NGTCP2_EXTERN uint64_t ngtcp2_conn_get_streams_bidi_left(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_streams_uni_left` returns the number of
 * unidirectional streams which the local endpoint can open without
 * violating stream concurrency limit.
 */
NGTCP2_EXTERN uint64_t ngtcp2_conn_get_streams_uni_left(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_cwnd_left` returns the cwnd minus the number of
 * bytes in flight on the current path.  If the former is smaller than
 * the latter, this function returns 0.
 */
NGTCP2_EXTERN uint64_t ngtcp2_conn_get_cwnd_left(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_set_initial_crypto_ctx` sets |ctx| for Initial packet
 * encryption.  The passed data will be passed to
 * :type:`ngtcp2_encrypt`, :type:`ngtcp2_decrypt` and
 * :type:`ngtcp2_hp_mask` callbacks.
 */
NGTCP2_EXTERN void
ngtcp2_conn_set_initial_crypto_ctx(ngtcp2_conn *conn,
                                   const ngtcp2_crypto_ctx *ctx);

/**
 * @function
 *
 * `ngtcp2_conn_get_initial_crypto_ctx` returns
 * :type:`ngtcp2_crypto_ctx` object for Initial packet encryption.
 */
NGTCP2_EXTERN const ngtcp2_crypto_ctx *
ngtcp2_conn_get_initial_crypto_ctx(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_set_crypto_ctx` sets |ctx| for Handshake/1-RTT packet
 * encryption.  The passed data will be passed to
 * :type:`ngtcp2_encrypt`, :type:`ngtcp2_decrypt` and
 * :type:`ngtcp2_hp_mask` callbacks.
 */
NGTCP2_EXTERN void ngtcp2_conn_set_crypto_ctx(ngtcp2_conn *conn,
                                              const ngtcp2_crypto_ctx *ctx);

/**
 * @function
 *
 * `ngtcp2_conn_get_crypto_ctx` returns :type:`ngtcp2_crypto_ctx`
 * object for Handshake/1-RTT packet encryption.
 */
NGTCP2_EXTERN const ngtcp2_crypto_ctx *
ngtcp2_conn_get_crypto_ctx(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_set_0rtt_crypto_ctx` sets |ctx| for 0-RTT packet
 * encryption.  The passed data will be passed to
 * :type:`ngtcp2_encrypt`, :type:`ngtcp2_decrypt` and
 * :type:`ngtcp2_hp_mask` callbacks.
 */
NGTCP2_EXTERN void
ngtcp2_conn_set_0rtt_crypto_ctx(ngtcp2_conn *conn,
                                const ngtcp2_crypto_ctx *ctx);

/**
 * @function
 *
 * `ngtcp2_conn_get_0rtt_crypto_ctx` returns :type:`ngtcp2_crypto_ctx`
 * object for 0-RTT packet encryption.
 */
NGTCP2_EXTERN const ngtcp2_crypto_ctx *
ngtcp2_conn_get_0rtt_crypto_ctx(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_tls_native_handle` returns TLS native handle set
 * by `ngtcp2_conn_set_tls_native_handle`.
 */
NGTCP2_EXTERN void *ngtcp2_conn_get_tls_native_handle(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_set_tls_native_handle` sets TLS native handle
 * |tls_native_handle| to |conn|.  Internally, it is used as an opaque
 * pointer.
 */
NGTCP2_EXTERN void ngtcp2_conn_set_tls_native_handle(ngtcp2_conn *conn,
                                                     void *tls_native_handle);

/**
 * @function
 *
 * `ngtcp2_conn_set_retry_aead` sets |aead| and |aead_ctx| for Retry
 * integrity tag verification.  |aead| must be AEAD_AES_128_GCM.
 * |aead_ctx| must be initialized with :macro:`NGTCP2_RETRY_KEY` as
 * encryption key.  This function must be called if |conn| is
 * initialized as client.  Server does not verify the tag, and has no
 * need to call this function.
 *
 * |conn| takes ownership of |aead_ctx|.
 * :member:`ngtcp2_callbacks.delete_crypto_aead_ctx` will be called to
 * delete this object when it is no longer used.
 */
NGTCP2_EXTERN void
ngtcp2_conn_set_retry_aead(ngtcp2_conn *conn, const ngtcp2_crypto_aead *aead,
                           const ngtcp2_crypto_aead_ctx *aead_ctx);

/**
 * @enum
 *
 * :type:`ngtcp2_ccerr_type` defines connection error type.
 */
typedef enum ngtcp2_ccerr_type {
  /**
   * :enum:`NGTCP2_CCERR_TYPE_TRANSPORT` indicates the QUIC transport
   * error, and the error code is QUIC transport error code.
   */
  NGTCP2_CCERR_TYPE_TRANSPORT,
  /**
   * :enum:`NGTCP2_CCERR_TYPE_APPLICATION` indicates an application
   * error, and the error code is application error code.
   */
  NGTCP2_CCERR_TYPE_APPLICATION,
  /**
   * :enum:`NGTCP2_CCERR_TYPE_VERSION_NEGOTIATION` is a special case
   * of QUIC transport error, and it indicates that client receives
   * Version Negotiation packet.
   */
  NGTCP2_CCERR_TYPE_VERSION_NEGOTIATION,
  /**
   * :enum:`NGTCP2_CCERR_TYPE_IDLE_CLOSE` is a special case of QUIC
   * transport error, and it indicates that connection is closed
   * because of idle timeout.
   */
  NGTCP2_CCERR_TYPE_IDLE_CLOSE,
  /**
   * :enum:`NGTCP2_CCERR_TYPE_DROP_CONN` is a special case of QUIC
   * transport error, and it indicates that connection should be
   * dropped without sending a CONNECTION_CLOSE frame.
   */
  NGTCP2_CCERR_TYPE_DROP_CONN,
  /**
   * :enum:`NGTCP2_CCERR_TYPE_RETRY` is a special case of QUIC
   * transport error, and it indicates that RETRY packet should be
   * sent to a client.
   */
  NGTCP2_CCERR_TYPE_RETRY
} ngtcp2_ccerr_type;

/**
 * @struct
 *
 * :type:`ngtcp2_ccerr` contains connection error code, its type, a
 * frame type that caused this error, and the optional reason phrase.
 */
typedef struct ngtcp2_ccerr {
  /**
   * :member:`type` is the type of this error.
   */
  ngtcp2_ccerr_type type;
  /**
   * :member:`error_code` is the error code for connection closure.
   * Its interpretation depends on :member:`type`.
   */
  uint64_t error_code;
  /**
   * :member:`frame_type` is the type of QUIC frame which triggers
   * this connection error.  This field is set to 0 if the frame type
   * is unknown.
   */
  uint64_t frame_type;
  /**
   * :member:`reason` points to the buffer which contains a reason
   * phrase.  It may be NULL if there is no reason phrase.  If it is
   * received from a remote endpoint, it is truncated to at most 1024
   * bytes.
   */
  const uint8_t *reason;
  /**
   * :member:`reasonlen` is the length of data pointed by
   * :member:`reason`.
   */
  size_t reasonlen;
} ngtcp2_ccerr;

/**
 * @function
 *
 * `ngtcp2_ccerr_default` initializes |ccerr| with the default values.
 * It sets the following fields:
 *
 * - :member:`type <ngtcp2_ccerr.type>` =
 *   :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_TRANSPORT`
 * - :member:`error_code <ngtcp2_ccerr.error_code>` =
 *   :macro:`NGTCP2_NO_ERROR`.
 * - :member:`frame_type <ngtcp2_ccerr.frame_type>` = 0
 * - :member:`reason <ngtcp2_ccerr.reason>` = NULL
 * - :member:`reasonlen <ngtcp2_ccerr.reasonlen>` = 0
 */
NGTCP2_EXTERN void ngtcp2_ccerr_default(ngtcp2_ccerr *ccerr);

/**
 * @function
 *
 * `ngtcp2_ccerr_set_transport_error` sets :member:`ccerr->type
 * <ngtcp2_ccerr.type>` to
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_TRANSPORT`, and
 * :member:`ccerr->error_code <ngtcp2_ccerr.error_code>` to
 * |error_code|.  |reason| is the reason phrase of length |reasonlen|.
 * This function does not make a copy of the reason phrase.
 */
NGTCP2_EXTERN void ngtcp2_ccerr_set_transport_error(ngtcp2_ccerr *ccerr,
                                                    uint64_t error_code,
                                                    const uint8_t *reason,
                                                    size_t reasonlen);

/**
 * @function
 *
 * `ngtcp2_ccerr_set_liberr` sets type and error_code based on
 * |liberr|.
 *
 * |reason| is the reason phrase of length |reasonlen|.  This function
 * does not make a copy of the reason phrase.
 *
 * If |liberr| is :macro:`NGTCP2_ERR_RECV_VERSION_NEGOTIATION`,
 * :member:`ccerr->type <ngtcp2_ccerr.type>` is set to
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_VERSION_NEGOTIATION`,
 * and :member:`ccerr->error_code <ngtcp2_ccerr.error_code>` to
 * :macro:`NGTCP2_NO_ERROR`.
 *
 * If |liberr| is :macro:`NGTCP2_ERR_IDLE_CLOSE`, :member:`ccerr->type
 * <ngtcp2_ccerr.type>` is set to
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_IDLE_CLOSE`, and
 * :member:`ccerr->error_code <ngtcp2_ccerr.error_code>` to
 * :macro:`NGTCP2_NO_ERROR`.
 *
 * If |liberr| is :macro:`NGTCP2_ERR_DROP_CONN`, :member:`ccerr->type
 * <ngtcp2_ccerr.type>` is set to
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_DROP_CONN`, and
 * :member:`ccerr->error_code <ngtcp2_ccerr.error_code>` to
 * :macro:`NGTCP2_NO_ERROR`.
 *
 * If |liberr| is :macro:`NGTCP2_ERR_RETRY`, :member:`ccerr->type
 * <ngtcp2_ccerr.type>` is set to
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_RETRY`, and
 * :member:`ccerr->error_type <ngtcp2_ccerr.error_code>` to
 * :macro:`NGTCP2_NO_ERROR`.
 *
 * Otherwise, :member:`ccerr->type <ngtcp2_ccerr.type>` is set to
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_TRANSPORT`, and
 * :member:`ccerr->error_code <ngtcp2_ccerr.error_code>` is set to an
 * error code inferred by |liberr| (see
 * `ngtcp2_err_infer_quic_transport_error_code`).
 */
NGTCP2_EXTERN void ngtcp2_ccerr_set_liberr(ngtcp2_ccerr *ccerr, int liberr,
                                           const uint8_t *reason,
                                           size_t reasonlen);

/**
 * @function
 *
 * `ngtcp2_ccerr_set_tls_alert` sets :member:`ccerr->type
 * <ngtcp2_ccerr.type>` to
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_TRANSPORT`, and
 * :member:`ccerr->error_code <ngtcp2_ccerr.error_code>` to bitwise-OR
 * of :macro:`NGTCP2_CRYPTO_ERROR` and |tls_alert|.  |reason| is the
 * reason phrase of length |reasonlen|.  This function does not make a
 * copy of the reason phrase.
 */
NGTCP2_EXTERN void ngtcp2_ccerr_set_tls_alert(ngtcp2_ccerr *ccerr,
                                              uint8_t tls_alert,
                                              const uint8_t *reason,
                                              size_t reasonlen);

/**
 * @function
 *
 * `ngtcp2_ccerr_set_application_error` sets :member:`ccerr->type
 * <ngtcp2_ccerr.type>` to
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_APPLICATION`, and
 * :member:`ccerr->error_code <ngtcp2_ccerr.error_code>` to
 * |error_code|.  |reason| is the reason phrase of length |reasonlen|.
 * This function does not make a copy of the reason phrase.
 */
NGTCP2_EXTERN void ngtcp2_ccerr_set_application_error(ngtcp2_ccerr *ccerr,
                                                      uint64_t error_code,
                                                      const uint8_t *reason,
                                                      size_t reasonlen);

/**
 * @function
 *
 * `ngtcp2_conn_write_connection_close` writes a packet which contains
 * CONNECTION_CLOSE frame(s) (type 0x1C or 0x1D) in the buffer pointed
 * by |dest| whose capacity is |destlen|.
 *
 * For client, |destlen| should be at least
 * :macro:`NGTCP2_MAX_UDP_PAYLOAD_SIZE`.
 *
 * If |path| is not ``NULL``, this function stores the network path
 * with which the packet should be sent.  Each addr field must point
 * to the buffer which should be at least
 * sizeof(:type:`ngtcp2_sockaddr_union`) bytes long.  The assignment
 * might not be done if nothing is written to |dest|.
 *
 * If |pi| is not ``NULL``, this function stores packet metadata in it
 * if it succeeds.  The metadata includes ECN markings.
 *
 * If :member:`ccerr->type <ngtcp2_ccerr.type>` ==
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_TRANSPORT`, this
 * function sends CONNECTION_CLOSE (type 0x1C) frame.  If
 * :member:`ccerr->type <ngtcp2_ccerr.type>` ==
 * :enum:`ngtcp2_ccerr_type.NGTCP2_CCERR_TYPE_APPLICATION`, it sends
 * CONNECTION_CLOSE (type 0x1D) frame.  Otherwise, it does not produce
 * any data, and returns 0.
 *
 * |destlen| could be shorten by some factors (e.g., server side
 * amplification limit).  This function returns
 * :macro:`NGTCP2_ERR_NOBUF` if the resulting buffer is too small even
 * if the given buffer has enough space.  This can happen if sending a
 * packet would exceed a transmission limit (e.g., for amplification
 * attack protection).
 *
 * This function must not be called from inside the callback
 * functions.
 *
 * At the moment, successful call to this function makes connection
 * close.  We may change this behaviour in the future to allow
 * graceful shutdown.
 *
 * This function returns the number of bytes written in |dest| if it
 * succeeds, or one of the following negative error codes:
 *
 * :macro:`NGTCP2_ERR_NOMEM`
 *     Out of memory
 * :macro:`NGTCP2_ERR_NOBUF`
 *     Buffer is too small or packet would exceed the transmission
 *     limit (e.g., for amplification attack protection).
 * :macro:`NGTCP2_ERR_INVALID_STATE`
 *     The current state does not allow sending CONNECTION_CLOSE
 *     frame.
 * :macro:`NGTCP2_ERR_PKT_NUM_EXHAUSTED`
 *     Packet number is exhausted, and cannot send any more packet.
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`
 *     User callback failed
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_write_connection_close_versioned(
  ngtcp2_conn *conn, ngtcp2_path *path, int pkt_info_version,
  ngtcp2_pkt_info *pi, uint8_t *dest, size_t destlen, const ngtcp2_ccerr *ccerr,
  ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_get_ccerr` returns the received connection close
 * error.  If no connection error is received, it returns
 * :type:`ngtcp2_ccerr` that is initialized by `ngtcp2_ccerr_default`.
 */
NGTCP2_EXTERN const ngtcp2_ccerr *ngtcp2_conn_get_ccerr(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_is_local_stream` returns nonzero if |stream_id|
 * denotes a locally initiated stream.
 */
NGTCP2_EXTERN int ngtcp2_conn_is_local_stream(ngtcp2_conn *conn,
                                              int64_t stream_id);

/**
 * @function
 *
 * `ngtcp2_conn_is_server` returns nonzero if |conn| is initialized as
 * server.
 */
NGTCP2_EXTERN int ngtcp2_conn_is_server(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_after_retry` returns nonzero if |conn| as a client has
 * received Retry packet from server, and successfully validated it.
 */
NGTCP2_EXTERN int ngtcp2_conn_after_retry(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_set_stream_user_data` sets |stream_user_data| to the
 * stream identified by |stream_id|.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_ERR_STREAM_NOT_FOUND`
 *     Stream does not exist
 */
NGTCP2_EXTERN int ngtcp2_conn_set_stream_user_data(ngtcp2_conn *conn,
                                                   int64_t stream_id,
                                                   void *stream_user_data);

/**
 * @function
 *
 * `ngtcp2_conn_get_stream_user_data` returns stream_user_data
 * associated to the stream identified by |stream_id|.  If the stream
 * is not found, or no stream data is associated to the stream, this
 * function returns NULL.
 *
 * The stream_user_data can be associated to the stream by one of the
 * following functions:
 *
 * - `ngtcp2_conn_open_bidi_stream`
 * - `ngtcp2_conn_open_uni_stream`
 * - `ngtcp2_conn_set_stream_user_data`
 *
 * This function has been available since v1.17.0.
 */
NGTCP2_EXTERN void *ngtcp2_conn_get_stream_user_data(ngtcp2_conn *conn,
                                                     int64_t stream_id);

/**
 * @function
 *
 * `ngtcp2_conn_update_pkt_tx_time` sets the time instant of the next
 * packet transmission to pace packets.  This function must be called
 * after (multiple invocation of) `ngtcp2_conn_writev_stream`.  If
 * packet aggregation (e.g., packet batching, GSO) is used, call this
 * function after all aggregated datagrams are sent, which indicates
 * multiple invocation of `ngtcp2_conn_writev_stream`.
 */
NGTCP2_EXTERN void ngtcp2_conn_update_pkt_tx_time(ngtcp2_conn *conn,
                                                  ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_get_send_quantum` returns the maximum number of bytes
 * that can be sent in one go without packet spacing.
 */
NGTCP2_EXTERN size_t ngtcp2_conn_get_send_quantum(ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_conn_get_stream_loss_count` returns the number of packets
 * that contain STREAM frame for a stream identified by |stream_id|
 * and are declared to be lost.  The number may include the spurious
 * losses.  If no stream identified by |stream_id| is found, this
 * function returns 0.
 */
NGTCP2_EXTERN size_t ngtcp2_conn_get_stream_loss_count(ngtcp2_conn *conn,
                                                       int64_t stream_id);

/**
 * @functypedef
 *
 * :type:`ngtcp2_write_pkt` is a callback function to write a single
 * packet in the buffer pointed by |dest| of length |destlen|.  The
 * implementation should use `ngtcp2_conn_write_pkt`,
 * `ngtcp2_conn_writev_stream`, `ngtcp2_conn_writev_datagram`, or
 * their variants to write the packet.  |path|, |pi|, |dest|,
 * |destlen|, and |ts| should be directly passed to those functions.
 * If the callback succeeds, it should return the number of bytes
 * written to the buffer.  In general, this callback function should
 * return the value that the above mentioned functions returned except
 * for the following error codes:
 *
 * - :macro:`NGTCP2_ERR_STREAM_DATA_BLOCKED`
 * - :macro:`NGTCP2_ERR_STREAM_SHUT_WR`
 * - :macro:`NGTCP2_ERR_STREAM_NOT_FOUND`
 *
 * Those error codes should be handled by an application.  If any
 * error occurred outside those functions, return
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`.  If no packet is produced,
 * return 0.
 *
 * Because GSO requires that the aggregated packets have the same
 * length, :macro:`NGTCP2_WRITE_STREAM_FLAG_PADDING` (or
 * :macro:`NGTCP2_WRITE_DATAGRAM_FLAG_PADDING` if
 * `ngtcp2_conn_writev_datagram` is used) is recommended.
 *
 * This callback function has been available since v1.15.0.
 */
typedef ngtcp2_ssize (*ngtcp2_write_pkt)(ngtcp2_conn *conn, ngtcp2_path *path,
                                         ngtcp2_pkt_info *pi, uint8_t *dest,
                                         size_t destlen, ngtcp2_tstamp ts,
                                         void *user_data);

/**
 * @function
 *
 * `ngtcp2_conn_write_aggregate_pkt` is a helper function to write
 * multiple packets in the provided buffer, which is suitable to be
 * sent at once in GSO.  This function returns the number of bytes
 * written to the buffer pointed by |buf| of length |buflen|.
 * |buflen| must be at least
 * `ngtcp2_conn_get_path_max_tx_udp_payload_size(conn)
 * <ngtcp2_conn_get_path_max_tx_udp_payload_size>` bytes long.  It is
 * recommended to pass the buffer at least
 * `ngtcp2_conn_get_max_tx_udp_payload_size(conn)
 * <ngtcp2_conn_get_max_tx_udp_payload_size>` bytes in order to send a
 * PMTUD packet.  This function only writes multiple packets if the
 * first packet is `ngtcp2_conn_get_path_max_tx_udp_payload_size(conn)
 * <ngtcp2_conn_get_path_max_tx_udp_payload_size>` bytes long.  The
 * application can adjust the length of the buffer to limit the number
 * of packets to aggregate (or use `ngtcp2_conn_write_aggregate_pkt2`
 * to control the number of packets to write directly).  If this
 * function returns positive integer, all packets share the same
 * :type:`ngtcp2_path` and :type:`ngtcp2_pkt_info` values, and they
 * are assigned to the objects pointed by |path| and |pi|
 * respectively.  The length of all packets other than the last packet
 * is assigned to |*pgsolen|.  The length of last packet is equal to
 * or less than |*pgsolen|.  |write_pkt| must write a single packet.
 * After all packets are written, this function calls
 * `ngtcp2_conn_update_pkt_tx_time`.
 *
 * This function is equivalent to call
 * `ngtcp2_conn_write_aggregate_pkt2` with |buflen| = min(|buflen|,
 * `ngtcp2_conn_get_send_quantum(conn)
 * <ngtcp2_conn_get_send_quantum>`) and |num_pkts| = 0 followed by
 * `ngtcp2_conn_update_pkt_tx_time(conn)
 * <ngtcp2_conn_update_pkt_tx_time>`.
 *
 * This function returns the number of bytes written to the buffer, or
 * a negative error code returned by |write_pkt|.
 *
 * This function has been available since v1.15.0.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_write_aggregate_pkt_versioned(
  ngtcp2_conn *conn, ngtcp2_path *path, int pkt_info_version,
  ngtcp2_pkt_info *pi, uint8_t *buf, size_t buflen, size_t *pgsolen,
  ngtcp2_write_pkt write_pkt, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_write_aggregate_pkt2` behaves like
 * `ngtcp2_conn_write_aggregate_pkt`, but it accepts |num_pkts| to
 * specify the maximum number of packets to write.  If |num_pkts| is
 * 0, this function writes packets as much as possible.  The actual
 * number of packets to write is determined by the connection state
 * (e.g., the congestion controller, data available to send) and the
 * length of packet produced.  It also does not clamp |buflen|, and
 * does not call `ngtcp2_conn_update_pkt_tx_time`.
 *
 * This function offers more flexibility and optimization chances to
 * an application.  It can experiment different GSO buffer size
 * strategy and number of GSO writes per event loop.
 *
 * This function has been available since v1.17.0.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_conn_write_aggregate_pkt2_versioned(
  ngtcp2_conn *conn, ngtcp2_path *path, int pkt_info_version,
  ngtcp2_pkt_info *pi, uint8_t *buf, size_t buflen, size_t *pgsolen,
  ngtcp2_write_pkt write_pkt, size_t num_pkts, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_conn_get_timestamp` returns the latest timestamp that is
 * known to |conn|.
 *
 * This function has been available since v1.16.0.
 */
NGTCP2_EXTERN ngtcp2_tstamp ngtcp2_conn_get_timestamp(const ngtcp2_conn *conn);

/**
 * @function
 *
 * `ngtcp2_strerror` returns the text representation of |liberr|.
 * |liberr| must be one of ngtcp2 library error codes (which is
 * defined as :macro:`NGTCP2_ERR_* <NGTCP2_ERR_INVALID_ARGUMENT>`
 * macros).
 */
NGTCP2_EXTERN const char *ngtcp2_strerror(int liberr);

/**
 * @function
 *
 * `ngtcp2_err_is_fatal` returns nonzero if |liberr| is a fatal error.
 * |liberr| must be one of ngtcp2 library error codes (which is
 * defined as :macro:`NGTCP2_ERR_* <NGTCP2_ERR_INVALID_ARGUMENT>`
 * macros).
 */
NGTCP2_EXTERN int ngtcp2_err_is_fatal(int liberr);

/**
 * @function
 *
 * `ngtcp2_err_infer_quic_transport_error_code` returns a QUIC
 * transport error code which corresponds to |liberr|.  |liberr| must
 * be one of ngtcp2 library error codes (which is defined as
 * :macro:`NGTCP2_ERR_* <NGTCP2_ERR_INVALID_ARGUMENT>` macros).
 */
NGTCP2_EXTERN uint64_t ngtcp2_err_infer_quic_transport_error_code(int liberr);

/**
 * @function
 *
 * `ngtcp2_addr_init` initializes |dest| with the given arguments and
 * returns |dest|.
 */
NGTCP2_EXTERN ngtcp2_addr *ngtcp2_addr_init(ngtcp2_addr *dest,
                                            const ngtcp2_sockaddr *addr,
                                            ngtcp2_socklen addrlen);

/**
 * @function
 *
 * `ngtcp2_addr_copy_byte` copies |addr| of length |addrlen| into the
 * buffer pointed by :member:`dest->addr <ngtcp2_addr.addr>`.
 * :member:`dest->addrlen <ngtcp2_addr.addrlen>` is updated to have
 * |addrlen|.  This function assumes that :member:`dest->addr
 * <ngtcp2_addr.addr>` points to a buffer which has a sufficient
 * capacity to store the copy.
 */
NGTCP2_EXTERN void ngtcp2_addr_copy_byte(ngtcp2_addr *dest,
                                         const ngtcp2_sockaddr *addr,
                                         ngtcp2_socklen addrlen);

/**
 * @function
 *
 * `ngtcp2_path_storage_init` initializes |ps| with the given
 * arguments.  This function copies |local_addr| and |remote_addr|.
 */
NGTCP2_EXTERN void ngtcp2_path_storage_init(ngtcp2_path_storage *ps,
                                            const ngtcp2_sockaddr *local_addr,
                                            ngtcp2_socklen local_addrlen,
                                            const ngtcp2_sockaddr *remote_addr,
                                            ngtcp2_socklen remote_addrlen,
                                            void *user_data);

/**
 * @function
 *
 * `ngtcp2_path_storage_zero` initializes |ps| with the zero length
 * addresses.
 */
NGTCP2_EXTERN void ngtcp2_path_storage_zero(ngtcp2_path_storage *ps);

/**
 * @function
 *
 * `ngtcp2_settings_default` initializes |settings| with the default
 * values.  First this function fills |settings| with 0, and set the
 * default value to the following fields:
 *
 * * :member:`cc_algo <ngtcp2_settings.cc_algo>` =
 *   :enum:`ngtcp2_cc_algo.NGTCP2_CC_ALGO_CUBIC`
 * * :member:`initial_rtt <ngtcp2_settings.initial_rtt>` =
 *   :macro:`NGTCP2_DEFAULT_INITIAL_RTT`
 * * :member:`ack_thresh <ngtcp2_settings.ack_thresh>` = 2
 * * :member:`max_tx_udp_payload_size
 *   <ngtcp2_settings.max_tx_udp_payload_size>` = 1452
 * * :member:`handshake_timeout <ngtcp2_settings.handshake_timeout>` =
 *   ``UINT64_MAX``
 * * :member:`glitch_ratelim_burst
 *   <ngtcp2_settings.glitch_ratelim_burst>` = 10000
 * * :member:`glitch_ratelim_rate
 *   <ngtcp2_settings.glitch_ratelim_rate>` = 330
 */
NGTCP2_EXTERN void ngtcp2_settings_default_versioned(int settings_version,
                                                     ngtcp2_settings *settings);

/**
 * @function
 *
 * `ngtcp2_transport_params_default` initializes |params| with the
 * default values.  First this function fills |params| with 0, and set
 * the default value to the following fields:
 *
 * * :member:`max_udp_payload_size
 *   <ngtcp2_transport_params.max_udp_payload_size>` =
 *   :macro:`NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE`
 * * :member:`ack_delay_exponent
 *   <ngtcp2_transport_params.ack_delay_exponent>` =
 *   :macro:`NGTCP2_DEFAULT_ACK_DELAY_EXPONENT`
 * * :member:`max_ack_delay <ngtcp2_transport_params.max_ack_delay>` =
 *   :macro:`NGTCP2_DEFAULT_MAX_ACK_DELAY`
 * * :member:`active_connection_id_limit
 *   <ngtcp2_transport_params.active_connection_id_limit>` =
 *   :macro:`NGTCP2_DEFAULT_ACTIVE_CONNECTION_ID_LIMIT`
 */
NGTCP2_EXTERN void
ngtcp2_transport_params_default_versioned(int transport_params_version,
                                          ngtcp2_transport_params *params);

/**
 * @function
 *
 * `ngtcp2_mem_default` returns the default, system standard memory
 * allocator.
 */
NGTCP2_EXTERN const ngtcp2_mem *ngtcp2_mem_default(void);

/**
 * @macrosection
 *
 * ngtcp2_info macros
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_VERSION_AGE` is the age of :type:`ngtcp2_info`
 */
#define NGTCP2_VERSION_AGE 1

/**
 * @struct
 *
 * :type:`ngtcp2_info` is what `ngtcp2_version` returns.  It holds
 * information about the particular ngtcp2 version.
 */
typedef struct ngtcp2_info {
  /**
   * :member:`age` is the age of this struct.  This instance of ngtcp2
   * sets it to :macro:`NGTCP2_VERSION_AGE` but a future version may
   * bump it and add more struct fields at the bottom
   */
  int age;
  /**
   * :member:`version_num` is the :macro:`NGTCP2_VERSION_NUM` number
   * (since :member:`age` ==1)
   */
  int version_num;
  /**
   * :member:`version_str` points to the :macro:`NGTCP2_VERSION`
   * string (since :member:`age` ==1)
   */
  const char *version_str;
  /* -------- the above fields all exist when age == 1 */
} ngtcp2_info;

/**
 * @function
 *
 * `ngtcp2_version` returns a pointer to a :type:`ngtcp2_info` struct
 * with version information about the run-time library in use.  The
 * |least_version| argument can be set to a 24 bit numerical value for
 * the least accepted version number, and if the condition is not met,
 * this function will return a ``NULL``.  Pass in 0 to skip the
 * version checking.
 */
NGTCP2_EXTERN const ngtcp2_info *ngtcp2_version(int least_version);

/**
 * @function
 *
 * `ngtcp2_is_bidi_stream` returns nonzero if |stream_id| denotes
 * bidirectional stream.
 */
NGTCP2_EXTERN int ngtcp2_is_bidi_stream(int64_t stream_id);

/**
 * @function
 *
 * `ngtcp2_path_copy` copies |src| into |dest|.  This function assumes
 * that |dest| has enough buffer to store the deep copy of
 * :member:`src->local <ngtcp2_path.local>` and :member:`src->remote
 * <ngtcp2_path.remote>`.
 */
NGTCP2_EXTERN void ngtcp2_path_copy(ngtcp2_path *dest, const ngtcp2_path *src);

/**
 * @function
 *
 * `ngtcp2_path_eq` returns nonzero if |a| and |b| shares the same
 * local and remote addresses.
 */
NGTCP2_EXTERN int ngtcp2_path_eq(const ngtcp2_path *a, const ngtcp2_path *b);

/**
 * @function
 *
 * `ngtcp2_is_supported_version` returns nonzero if the library
 * supports QUIC version |version|.
 */
NGTCP2_EXTERN int ngtcp2_is_supported_version(uint32_t version);

/**
 * @function
 *
 * `ngtcp2_is_reserved_version` returns nonzero if |version| is a
 * reserved version.
 */
NGTCP2_EXTERN int ngtcp2_is_reserved_version(uint32_t version);

/**
 * @function
 *
 * `ngtcp2_select_version` selects and returns a version from the
 * version set |offered_versions| of |offered_versionslen| elements.
 * |preferred_versions| of |preferred_versionslen| elements specifies
 * the preference of versions, which is sorted in the order of
 * preference.  All versions included in |preferred_versions| must be
 * supported by the library, that is, passing any version in the array
 * to `ngtcp2_is_supported_version` must return nonzero.  This
 * function is intended to be used by client when it receives Version
 * Negotiation packet.  If no version is selected, this function
 * returns 0.
 */
NGTCP2_EXTERN uint32_t ngtcp2_select_version(const uint32_t *preferred_versions,
                                             size_t preferred_versionslen,
                                             const uint32_t *offered_versions,
                                             size_t offered_versionslen);

/*
 * Versioned function wrappers
 */

/*
 * `ngtcp2_conn_read_pkt` is a wrapper around
 * `ngtcp2_conn_read_pkt_versioned` to set the correct struct version.
 */
#define ngtcp2_conn_read_pkt(CONN, PATH, PI, PKT, PKTLEN, TS)                  \
  ngtcp2_conn_read_pkt_versioned((CONN), (PATH), NGTCP2_PKT_INFO_VERSION,      \
                                 (PI), (PKT), (PKTLEN), (TS))

/*
 * `ngtcp2_conn_write_pkt` is a wrapper around
 * `ngtcp2_conn_write_pkt_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_conn_write_pkt(CONN, PATH, PI, DEST, DESTLEN, TS)               \
  ngtcp2_conn_write_pkt_versioned((CONN), (PATH), NGTCP2_PKT_INFO_VERSION,     \
                                  (PI), (DEST), (DESTLEN), (TS))

/*
 * `ngtcp2_conn_write_stream` is a wrapper around
 * `ngtcp2_conn_write_stream_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_conn_write_stream(CONN, PATH, PI, DEST, DESTLEN, PDATALEN,      \
                                 FLAGS, STREAM_ID, DATA, DATALEN, TS)          \
  ngtcp2_conn_write_stream_versioned(                                          \
    (CONN), (PATH), NGTCP2_PKT_INFO_VERSION, (PI), (DEST), (DESTLEN),          \
    (PDATALEN), (FLAGS), (STREAM_ID), (DATA), (DATALEN), (TS))

/*
 * `ngtcp2_conn_writev_stream` is a wrapper around
 * `ngtcp2_conn_writev_stream_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_conn_writev_stream(CONN, PATH, PI, DEST, DESTLEN, PDATALEN,     \
                                  FLAGS, STREAM_ID, DATAV, DATAVCNT, TS)       \
  ngtcp2_conn_writev_stream_versioned(                                         \
    (CONN), (PATH), NGTCP2_PKT_INFO_VERSION, (PI), (DEST), (DESTLEN),          \
    (PDATALEN), (FLAGS), (STREAM_ID), (DATAV), (DATAVCNT), (TS))

/*
 * `ngtcp2_conn_write_datagram` is a wrapper around
 * `ngtcp2_conn_write_datagram_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_conn_write_datagram(CONN, PATH, PI, DEST, DESTLEN, PACCEPTED,   \
                                   FLAGS, DGRAM_ID, DATA, DATALEN, TS)         \
  ngtcp2_conn_write_datagram_versioned(                                        \
    (CONN), (PATH), NGTCP2_PKT_INFO_VERSION, (PI), (DEST), (DESTLEN),          \
    (PACCEPTED), (FLAGS), (DGRAM_ID), (DATA), (DATALEN), (TS))

/*
 * `ngtcp2_conn_writev_datagram` is a wrapper around
 * `ngtcp2_conn_writev_datagram_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_conn_writev_datagram(CONN, PATH, PI, DEST, DESTLEN, PACCEPTED,  \
                                    FLAGS, DGRAM_ID, DATAV, DATAVCNT, TS)      \
  ngtcp2_conn_writev_datagram_versioned(                                       \
    (CONN), (PATH), NGTCP2_PKT_INFO_VERSION, (PI), (DEST), (DESTLEN),          \
    (PACCEPTED), (FLAGS), (DGRAM_ID), (DATAV), (DATAVCNT), (TS))

/*
 * `ngtcp2_conn_write_connection_close` is a wrapper around
 * `ngtcp2_conn_write_connection_close_versioned` to set the correct
 * struct version.
 */
#define ngtcp2_conn_write_connection_close(CONN, PATH, PI, DEST, DESTLEN,      \
                                           CCERR, TS)                          \
  ngtcp2_conn_write_connection_close_versioned(                                \
    (CONN), (PATH), NGTCP2_PKT_INFO_VERSION, (PI), (DEST), (DESTLEN), (CCERR), \
    (TS))

/*
 * `ngtcp2_transport_params_encode` is a wrapper around
 * `ngtcp2_transport_params_encode_versioned` to set the correct
 * struct version.
 */
#define ngtcp2_transport_params_encode(DEST, DESTLEN, PARAMS)                  \
  ngtcp2_transport_params_encode_versioned(                                    \
    (DEST), (DESTLEN), NGTCP2_TRANSPORT_PARAMS_VERSION, (PARAMS))

/*
 * `ngtcp2_transport_params_decode` is a wrapper around
 * `ngtcp2_transport_params_decode_versioned` to set the correct
 * struct version.
 */
#define ngtcp2_transport_params_decode(PARAMS, DATA, DATALEN)                  \
  ngtcp2_transport_params_decode_versioned(NGTCP2_TRANSPORT_PARAMS_VERSION,    \
                                           (PARAMS), (DATA), (DATALEN))

/*
 * `ngtcp2_conn_client_new` is a wrapper around
 * `ngtcp2_conn_client_new_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_conn_client_new(PCONN, DCID, SCID, PATH, VERSION, CALLBACKS,    \
                               SETTINGS, PARAMS, MEM, USER_DATA)               \
  ngtcp2_conn_client_new_versioned(                                            \
    (PCONN), (DCID), (SCID), (PATH), (VERSION), NGTCP2_CALLBACKS_VERSION,      \
    (CALLBACKS), NGTCP2_SETTINGS_VERSION, (SETTINGS),                          \
    NGTCP2_TRANSPORT_PARAMS_VERSION, (PARAMS), (MEM), (USER_DATA))

/*
 * `ngtcp2_conn_server_new` is a wrapper around
 * `ngtcp2_conn_server_new_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_conn_server_new(PCONN, DCID, SCID, PATH, VERSION, CALLBACKS,    \
                               SETTINGS, PARAMS, MEM, USER_DATA)               \
  ngtcp2_conn_server_new_versioned(                                            \
    (PCONN), (DCID), (SCID), (PATH), (VERSION), NGTCP2_CALLBACKS_VERSION,      \
    (CALLBACKS), NGTCP2_SETTINGS_VERSION, (SETTINGS),                          \
    NGTCP2_TRANSPORT_PARAMS_VERSION, (PARAMS), (MEM), (USER_DATA))

/*
 * `ngtcp2_conn_set_local_transport_params` is a wrapper around
 * `ngtcp2_conn_set_local_transport_params_versioned` to set the
 * correct struct version.
 */
#define ngtcp2_conn_set_local_transport_params(CONN, PARAMS)                   \
  ngtcp2_conn_set_local_transport_params_versioned(                            \
    (CONN), NGTCP2_TRANSPORT_PARAMS_VERSION, (PARAMS))

/*
 * `ngtcp2_transport_params_default` is a wrapper around
 * `ngtcp2_transport_params_default_versioned` to set the correct
 * struct version.
 */
#define ngtcp2_transport_params_default(PARAMS)                                \
  ngtcp2_transport_params_default_versioned(NGTCP2_TRANSPORT_PARAMS_VERSION,   \
                                            (PARAMS))

/*
 * `ngtcp2_conn_get_conn_info` is a wrapper around
 * `ngtcp2_conn_get_conn_info_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_conn_get_conn_info(CONN, CINFO)                                 \
  ngtcp2_conn_get_conn_info_versioned((CONN), NGTCP2_CONN_INFO_VERSION, (CINFO))

/*
 * `ngtcp2_conn_write_aggregate_pkt` is a wrapper around
 * `ngtcp2_conn_write_aggregate_pkt_versioned` to set the correct
 * struct version.
 */
#define ngtcp2_conn_write_aggregate_pkt(CONN, PATH, PI, BUF, BUFLEN, PGSOLEN,  \
                                        WRITE_PKT, TS)                         \
  ngtcp2_conn_write_aggregate_pkt_versioned(                                   \
    (CONN), (PATH), NGTCP2_PKT_INFO_VERSION, (PI), (BUF), (BUFLEN), (PGSOLEN), \
    (WRITE_PKT), (TS))

/*
 * `ngtcp2_conn_write_aggregate_pkt2` is a wrapper around
 * `ngtcp2_conn_write_aggregate_pkt2_versioned` to set the correct
 * struct version.
 */
#define ngtcp2_conn_write_aggregate_pkt2(CONN, PATH, PI, BUF, BUFLEN, PGSOLEN, \
                                         WRITE_PKT, NUM_PKTS, TS)              \
  ngtcp2_conn_write_aggregate_pkt2_versioned(                                  \
    (CONN), (PATH), NGTCP2_PKT_INFO_VERSION, (PI), (BUF), (BUFLEN), (PGSOLEN), \
    (WRITE_PKT), (NUM_PKTS), (TS))

/*
 * `ngtcp2_settings_default` is a wrapper around
 * `ngtcp2_settings_default_versioned` to set the correct struct
 * version.
 */
#define ngtcp2_settings_default(SETTINGS)                                      \
  ngtcp2_settings_default_versioned(NGTCP2_SETTINGS_VERSION, (SETTINGS))

#ifdef _MSC_VER
#  pragma warning(pop)
#endif /* defined(_MSC_VER) */

#ifdef __cplusplus
}
#endif /* defined(__cplusplus) */

#endif /* !defined(NGTCP2_H) */
