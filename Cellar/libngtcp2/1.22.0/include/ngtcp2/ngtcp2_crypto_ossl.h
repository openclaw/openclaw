/*
 * ngtcp2
 *
 * Copyright (c) 2025 ngtcp2 contributors
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
#ifndef NGTCP2_CRYPTO_OSSL_H
#define NGTCP2_CRYPTO_OSSL_H

#include <ngtcp2/ngtcp2.h>

#include <openssl/ssl.h>

#ifdef __cplusplus
extern "C" {
#endif /* defined(__cplusplus) */

/**
 * @macrosection
 *
 * ossl specific error codes
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_OSSL_ERR_TLS_WANT_X509_LOOKUP` is the error
 * code which indicates that TLS handshake routine is interrupted by
 * X509 certificate lookup.  See :macro:`SSL_ERROR_WANT_X509_LOOKUP`
 * error description from `SSL_do_handshake`.
 */
#define NGTCP2_CRYPTO_OSSL_ERR_TLS_WANT_X509_LOOKUP -10001

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_OSSL_ERR_TLS_WANT_CLIENT_HELLO_CB` is the
 * error code which indicates that TLS handshake routine is
 * interrupted by client hello callback.  See
 * :macro:`SSL_ERROR_WANT_CLIENT_HELLO_CB` error description from
 * `SSL_do_handshake`.
 */
#define NGTCP2_CRYPTO_OSSL_ERR_TLS_WANT_CLIENT_HELLO_CB -10002

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_from_ossl_encryption_level` translates
 * |ossl_level| to :type:`ngtcp2_encryption_level`.  This function is
 * only available for ossl backend.
 */
NGTCP2_EXTERN ngtcp2_encryption_level
ngtcp2_crypto_ossl_from_ossl_encryption_level(uint32_t ossl_level);

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_from_ngtcp2_encryption_level` translates
 * |encryption_level| to OpenSSL encryption level.  This function is
 * only available for ossl backend.
 */
NGTCP2_EXTERN uint32_t ngtcp2_crypto_ossl_from_ngtcp2_encryption_level(
  ngtcp2_encryption_level encryption_level);

/**
 * @struct
 *
 * :type:`ngtcp2_crypto_ossl_ctx` contains per-connection state, and
 * must be set to `ngtcp2_conn_set_tls_native_handle`.
 */
typedef struct ngtcp2_crypto_ossl_ctx ngtcp2_crypto_ossl_ctx;

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_ctx_new` creates new
 * :type:`ngtcp2_crypto_ossl_ctx` object, and sets it to |*pctx| if it
 * succeeds.
 *
 * |ssl| is set to |*pctx|.  It may be NULL, and in that case, call
 * `ngtcp2_crypto_ossl_ctx_set_ssl` later to set ``SSL`` object.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :enum:`NGTCP2_CRYPTO_ERR_NOMEM`
 *     Out of memory
 */
NGTCP2_EXTERN int ngtcp2_crypto_ossl_ctx_new(ngtcp2_crypto_ossl_ctx **pctx,
                                             SSL *ssl);

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_ctx_del` frees resources allocated for |ctx|.
 * It also frees memory pointed by |ctx|.
 */
NGTCP2_EXTERN void ngtcp2_crypto_ossl_ctx_del(ngtcp2_crypto_ossl_ctx *ctx);

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_ctx_set_ssl` sets |ssl| to |ctx|.  This
 * function must be called after ``SSL`` object is created.
 */
NGTCP2_EXTERN void ngtcp2_crypto_ossl_ctx_set_ssl(ngtcp2_crypto_ossl_ctx *ctx,
                                                  SSL *ssl);

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_ctx_get_ssl` returns ``SSL`` object set to
 * |ctx|.  If the object has not been set, this function returns NULL.
 */
NGTCP2_EXTERN SSL *ngtcp2_crypto_ossl_ctx_get_ssl(ngtcp2_crypto_ossl_ctx *ctx);

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_init` initializes libngtcp2_crypto_ossl
 * library.  This initialization is optional.  It is highly
 * recommended to call this function before any use of
 * libngtcp2_crypto library API to workaround the performance
 * regression.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_ossl_init(void);

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_configure_server_session` configures |ssl| for
 * server side QUIC connection.  It performs the following
 * modifications:
 *
 * - Register callbacks via ``SSL_set_quic_tls_cbs``
 *
 * Application must set a pointer to :type:`ngtcp2_crypto_conn_ref` to
 * SSL object by calling SSL_set_app_data, and
 * :type:`ngtcp2_crypto_conn_ref` object must have
 * :member:`ngtcp2_crypto_conn_ref.get_conn` field assigned to get
 * :type:`ngtcp2_conn`.
 *
 * Application must call ``SSL_set_app_data(ssl, NULL)`` before
 * calling ``SSL_free(ssl)`` if you cannot make `ngtcp2_conn` object
 * alive until ``SSL_free`` is called.
 *
 * It returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_ossl_configure_server_session(SSL *ssl);

/**
 * @function
 *
 * `ngtcp2_crypto_ossl_configure_client_session` configures |ssl| for
 * client side QUIC connection.  It performs the following
 * modifications:
 *
 * - Register callbacks via ``SSL_set_quic_tls_cbs``
 *
 * Application must set a pointer to :type:`ngtcp2_crypto_conn_ref` to
 * SSL object by calling SSL_set_app_data, and
 * :type:`ngtcp2_crypto_conn_ref` object must have
 * :member:`ngtcp2_crypto_conn_ref.get_conn` field assigned to get
 * :type:`ngtcp2_conn`.
 *
 * Application must call ``SSL_set_app_data(ssl, NULL)`` before
 * calling ``SSL_free(ssl)`` if you cannot make `ngtcp2_conn` object
 * alive until ``SSL_free`` is called.
 *
 * It returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_ossl_configure_client_session(SSL *ssl);

#ifdef __cplusplus
}
#endif /* defined(__cplusplus) */

#endif /* !defined(NGTCP2_CRYPTO_OSSL_H) */
