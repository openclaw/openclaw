/*
 * ngtcp2
 *
 * Copyright (c) 2019 ngtcp2 contributors
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
#ifndef NGTCP2_CRYPTO_H
#define NGTCP2_CRYPTO_H

#include <ngtcp2/ngtcp2.h>

#ifdef __cplusplus
extern "C" {
#endif /* defined(__cplusplus) */

#ifdef WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif /* !defined(WIN32_LEAN_AND_MEAN) */
#  include <ws2tcpip.h>
#endif /* defined(WIN32) */

/**
 * @macrosection
 *
 * ngtcp2 crypto library error codes
 */

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_ERR_INTERNAL` indicates an internal error.
 */
#define NGTCP2_CRYPTO_ERR_INTERNAL -201

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_ERR_UNREADABLE_TOKEN` indicates that a token
 * is unreadable because it is not correctly formatted; or verifying
 * the integrity protection failed.
 */
#define NGTCP2_CRYPTO_ERR_UNREADABLE_TOKEN -202

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_ERR_VERIFY_TOKEN` indicates that a token does
 * not probe the client address; or the token validity has expired; or
 * it contains invalid Connection ID.
 */
#define NGTCP2_CRYPTO_ERR_VERIFY_TOKEN -203

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_ERR_NOMEM` indicates out of memory.
 */
#define NGTCP2_CRYPTO_ERR_NOMEM -501

/**
 * @function
 *
 * `ngtcp2_crypto_ctx_tls` initializes |ctx| by extracting negotiated
 * ciphers and message digests from native TLS session
 * |tls_native_handle|.  This is used for encrypting/decrypting
 * Handshake and 1-RTT packets.  If it is unable to obtain necessary
 * data from |tls_native_handle|, this function returns NULL.
 *
 * If libngtcp2_crypto_quictls is linked, |tls_native_handle| must be
 * a pointer to SSL object.
 */
NGTCP2_EXTERN ngtcp2_crypto_ctx *ngtcp2_crypto_ctx_tls(ngtcp2_crypto_ctx *ctx,
                                                       void *tls_native_handle);

/**
 * @function
 *
 * `ngtcp2_crypto_ctx_tls_early` initializes |ctx| by extracting early
 * ciphers and message digests from native TLS session
 * |tls_native_handle|.  This is used for encrypting/decrypting 0-RTT
 * packets.  If it is unable to obtain necessary data from
 * |tls_native_handle|, this function returns NULL.
 *
 * If libngtcp2_crypto_quictls is linked, |tls_native_handle| must be
 * a pointer to SSL object.
 */
NGTCP2_EXTERN ngtcp2_crypto_ctx *
ngtcp2_crypto_ctx_tls_early(ngtcp2_crypto_ctx *ctx, void *tls_native_handle);

/**
 * @function
 *
 * `ngtcp2_crypto_md_init` initializes |md| with the provided
 * |md_native_handle| which is an underlying message digest object.
 *
 * If libngtcp2_crypto_quictls is linked, |md_native_handle| must be a
 * pointer to EVP_MD.
 *
 * If libngtcp2_crypto_gnutls is linked, |md_native_handle| must be
 * gnutls_mac_algorithm_t casted to ``void *``.
 *
 * If libngtcp2_crypto_boringssl is linked, |md_native_handle| must be
 * a pointer to EVP_MD.
 */
NGTCP2_EXTERN ngtcp2_crypto_md *ngtcp2_crypto_md_init(ngtcp2_crypto_md *md,
                                                      void *md_native_handle);

/**
 * @function
 *
 * `ngtcp2_crypto_md_hashlen` returns the length of |md| output.
 */
NGTCP2_EXTERN size_t ngtcp2_crypto_md_hashlen(const ngtcp2_crypto_md *md);

/**
 * @function
 *
 * `ngtcp2_crypto_aead_keylen` returns the length of key for |aead|.
 */
NGTCP2_EXTERN size_t ngtcp2_crypto_aead_keylen(const ngtcp2_crypto_aead *aead);

/**
 * @function
 *
 * `ngtcp2_crypto_aead_noncelen` returns the length of nonce for
 * |aead|.
 */
NGTCP2_EXTERN size_t
ngtcp2_crypto_aead_noncelen(const ngtcp2_crypto_aead *aead);

/**
 * @function
 *
 * `ngtcp2_crypto_hkdf_extract` performs HKDF extract operation.
 *
 * The length of output is `ngtcp2_crypto_md_hashlen(md)
 * <ngtcp2_crypto_md_hashlen>`.  The output is stored in the buffer
 * pointed by |dest|.  The caller is responsible to specify the buffer
 * that has enough capacity to store the output.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int
ngtcp2_crypto_hkdf_extract(uint8_t *dest, const ngtcp2_crypto_md *md,
                           const uint8_t *secret, size_t secretlen,
                           const uint8_t *salt, size_t saltlen);

/**
 * @function
 *
 * `ngtcp2_crypto_hkdf_expand` performs HKDF expand operation.  The
 * result is |destlen| bytes long, and is stored in the buffer pointed
 * by |dest|.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_hkdf_expand(
  uint8_t *dest, size_t destlen, const ngtcp2_crypto_md *md,
  const uint8_t *secret, size_t secretlen, const uint8_t *info, size_t infolen);

/**
 * @function
 *
 * `ngtcp2_crypto_hkdf` performs HKDF operation.  The result is
 * |destlen| bytes long, and is stored in the buffer pointed by
 * |dest|.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_hkdf(uint8_t *dest, size_t destlen,
                                     const ngtcp2_crypto_md *md,
                                     const uint8_t *secret, size_t secretlen,
                                     const uint8_t *salt, size_t saltlen,
                                     const uint8_t *info, size_t infolen);

/**
 * @function
 *
 * `ngtcp2_crypto_packet_protection_ivlen` returns the length of IV
 * used to encrypt QUIC packet.
 */
NGTCP2_EXTERN size_t
ngtcp2_crypto_packet_protection_ivlen(const ngtcp2_crypto_aead *aead);

/**
 * @function
 *
 * `ngtcp2_crypto_encrypt` encrypts |plaintext| of length
 * |plaintextlen| and writes the ciphertext into the buffer pointed by
 * |dest|.  The length of ciphertext is |plaintextlen| +
 * :member:`aead->max_overhead <ngtcp2_crypto_aead.max_overhead>`
 * bytes long.  |dest| must have enough capacity to store the
 * ciphertext.  |dest| and |plaintext| may point to the same buffer.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_encrypt(uint8_t *dest,
                                        const ngtcp2_crypto_aead *aead,
                                        const ngtcp2_crypto_aead_ctx *aead_ctx,
                                        const uint8_t *plaintext,
                                        size_t plaintextlen,
                                        const uint8_t *nonce, size_t noncelen,
                                        const uint8_t *aad, size_t aadlen);

/**
 * @function
 *
 * `ngtcp2_crypto_encrypt_cb` is a wrapper function around
 * `ngtcp2_crypto_encrypt`.  It can be directly passed to
 * :member:`ngtcp2_callbacks.encrypt` field.
 *
 * This function returns 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`.
 */
NGTCP2_EXTERN int
ngtcp2_crypto_encrypt_cb(uint8_t *dest, const ngtcp2_crypto_aead *aead,
                         const ngtcp2_crypto_aead_ctx *aead_ctx,
                         const uint8_t *plaintext, size_t plaintextlen,
                         const uint8_t *nonce, size_t noncelen,
                         const uint8_t *aad, size_t aadlen);

/**
 * @function
 *
 * `ngtcp2_crypto_decrypt` decrypts |ciphertext| of length
 * |ciphertextlen| and writes the plaintext into the buffer pointed by
 * |dest|.  The length of plaintext is |ciphertextlen| -
 * :member:`aead->max_overhead <ngtcp2_crypto_aead.max_overhead>`
 * bytes long.  |dest| must have enough capacity to store the
 * plaintext.  |dest| and |ciphertext| may point to the same buffer.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_decrypt(uint8_t *dest,
                                        const ngtcp2_crypto_aead *aead,
                                        const ngtcp2_crypto_aead_ctx *aead_ctx,
                                        const uint8_t *ciphertext,
                                        size_t ciphertextlen,
                                        const uint8_t *nonce, size_t noncelen,
                                        const uint8_t *aad, size_t aadlen);

/**
 * @function
 *
 * `ngtcp2_crypto_decrypt_cb` is a wrapper function around
 * `ngtcp2_crypto_decrypt`.  It can be directly passed to
 * :member:`ngtcp2_callbacks.decrypt` field.
 *
 * This function returns 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_TLS_DECRYPT`.
 */
NGTCP2_EXTERN int
ngtcp2_crypto_decrypt_cb(uint8_t *dest, const ngtcp2_crypto_aead *aead,
                         const ngtcp2_crypto_aead_ctx *aead_ctx,
                         const uint8_t *ciphertext, size_t ciphertextlen,
                         const uint8_t *nonce, size_t noncelen,
                         const uint8_t *aad, size_t aadlen);

/**
 * @function
 *
 * `ngtcp2_crypto_hp_mask` generates a mask which is used in packet
 * header encryption.  The mask is written to the buffer pointed by
 * |dest|.  The sample is passed as |sample| which is
 * :macro:`NGTCP2_HP_SAMPLELEN` bytes long.  The length of mask must
 * be at least :macro:`NGTCP2_HP_MASKLEN`.  The library only uses the
 * first :macro:`NGTCP2_HP_MASKLEN` bytes of the produced mask.  The
 * buffer pointed by |dest| must have at least
 * :macro:`NGTCP2_HP_SAMPLELEN` bytes available.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_hp_mask(uint8_t *dest,
                                        const ngtcp2_crypto_cipher *hp,
                                        const ngtcp2_crypto_cipher_ctx *hp_ctx,
                                        const uint8_t *sample);

/**
 * @function
 *
 * `ngtcp2_crypto_hp_mask_cb` is a wrapper function around
 * `ngtcp2_crypto_hp_mask`.  It can be directly passed to
 * :member:`ngtcp2_callbacks.hp_mask` field.
 *
 * This function returns 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`.
 */
NGTCP2_EXTERN int
ngtcp2_crypto_hp_mask_cb(uint8_t *dest, const ngtcp2_crypto_cipher *hp,
                         const ngtcp2_crypto_cipher_ctx *hp_ctx,
                         const uint8_t *sample);

/**
 * @function
 *
 * `ngtcp2_crypto_derive_and_install_rx_key` derives the decryption
 * keying materials from |secret|, and installs them to |conn|.
 *
 * If |key| is not NULL, the derived packet protection key is written
 * to the buffer pointed by |key|.  If |iv| is not NULL, the derived
 * packet protection IV is written to the buffer pointed by |iv|.  If
 * |hp| is not NULL, the derived header protection key is written to
 * the buffer pointed by |hp|.
 *
 * |secretlen| specifies the length of |secret|.
 *
 * The length of packet protection key and header protection key is
 * `ngtcp2_crypto_aead_keylen(ctx->aead) <ngtcp2_crypto_aead_keylen>`,
 * and the length of packet protection IV is
 * `ngtcp2_crypto_packet_protection_ivlen(ctx->aead)
 * <ngtcp2_crypto_packet_protection_ivlen>` where ctx is obtained by
 * `ngtcp2_crypto_ctx_tls` (or `ngtcp2_crypto_ctx_tls_early` if
 * |level| ==
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_0RTT`).
 *
 * In the first call of this function, it calls
 * `ngtcp2_conn_set_crypto_ctx` (or `ngtcp2_conn_set_early_crypto_ctx`
 * if |level| ==
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_0RTT`) to
 * set negotiated AEAD and message digest algorithm.  After the
 * successful call of this function, application can use
 * `ngtcp2_conn_get_crypto_ctx` (or `ngtcp2_conn_get_0rtt_crypto_ctx`
 * if |level| ==
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_0RTT`) to
 * get :type:`ngtcp2_crypto_ctx`.
 *
 * If |conn| is initialized as client, and |level| is
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_1RTT`, this
 * function retrieves a remote QUIC transport parameters extension
 * from an object obtained by `ngtcp2_conn_get_tls_native_handle`, and
 * sets it to |conn| by calling
 * `ngtcp2_conn_decode_and_set_remote_transport_params`.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_derive_and_install_rx_key(
  ngtcp2_conn *conn, uint8_t *key, uint8_t *iv, uint8_t *hp,
  ngtcp2_encryption_level level, const uint8_t *secret, size_t secretlen);

/**
 * @function
 *
 * `ngtcp2_crypto_derive_and_install_tx_key` derives the encryption
 * keying materials from |secret|, and installs new keys to |conn|.
 *
 * If |key| is not NULL, the derived packet protection key is written
 * to the buffer pointed by |key|.  If |iv| is not NULL, the derived
 * packet protection IV is written to the buffer pointed by |iv|.  If
 * |hp| is not NULL, the derived header protection key is written to
 * the buffer pointed by |hp|.
 *
 * |secretlen| specifies the length of |secret|.
 *
 * The length of packet protection key and header protection key is
 * `ngtcp2_crypto_aead_keylen(ctx->aead) <ngtcp2_crypto_aead_keylen>`,
 * and the length of packet protection IV is
 * `ngtcp2_crypto_packet_protection_ivlen(ctx->aead)
 * <ngtcp2_crypto_packet_protection_ivlen>` where ctx is obtained by
 * `ngtcp2_crypto_ctx_tls` (or `ngtcp2_crypto_ctx_tls_early` if
 * |level| ==
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_0RTT`).
 *
 * In the first call of this function, it calls
 * `ngtcp2_conn_set_crypto_ctx` (or `ngtcp2_conn_set_early_crypto_ctx`
 * if |level| ==
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_0RTT`) to
 * set negotiated AEAD and message digest algorithm.  After the
 * successful call of this function, application can use
 * `ngtcp2_conn_get_crypto_ctx` (or `ngtcp2_conn_get_0rtt_crypto_ctx`
 * if |level| ==
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_0RTT`) to
 * get :type:`ngtcp2_crypto_ctx`.
 *
 * If |conn| is initialized as server, and |level| is
 * :enum:`ngtcp2_encryption_level.NGTCP2_ENCRYPTION_LEVEL_1RTT`, this
 * function retrieves a remote QUIC transport parameters extension
 * from an object obtained by `ngtcp2_conn_get_tls_native_handle`, and
 * sets it to |conn| by calling
 * `ngtcp2_conn_decode_and_set_remote_transport_params`.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_derive_and_install_tx_key(
  ngtcp2_conn *conn, uint8_t *key, uint8_t *iv, uint8_t *hp,
  ngtcp2_encryption_level level, const uint8_t *secret, size_t secretlen);

/**
 * @function
 *
 * `ngtcp2_crypto_update_key` updates traffic keying materials.
 *
 * The new decryption traffic secret is written to the buffer pointed
 * by |rx_secret|.  The length of secret is |secretlen| bytes, and
 * |rx_secret| must point to the buffer which has enough capacity.
 *
 * The new encryption traffic secret is written to the buffer pointed
 * by |tx_secret|.  The length of secret is |secretlen| bytes, and
 * |tx_secret| must point to the buffer which has enough capacity.
 *
 * The derived decryption packet protection key is written to the
 * buffer pointed by |rx_key|.  The derived decryption packet
 * protection IV is written to the buffer pointed by |rx_iv|.
 * |rx_aead_ctx| is initialized with the derived key and IV.
 *
 * The derived encryption packet protection key is written to the
 * buffer pointed by |tx_key|.  The derived encryption packet
 * protection IV is written to the buffer pointed by |tx_iv|.
 * |tx_aead_ctx| is initialized with the derived key and IV.
 *
 * |current_rx_secret| and |current_tx_secret| are the current
 * decryption and encryption traffic secrets respectively.  They share
 * the same length with |rx_secret| and |tx_secret|.
 *
 * The length of packet protection key and header protection key is
 * `ngtcp2_crypto_aead_keylen(ctx->aead) <ngtcp2_crypto_aead_keylen>`,
 * and the length of packet protection IV is
 * `ngtcp2_crypto_packet_protection_ivlen(ctx->aead)
 * <ngtcp2_crypto_packet_protection_ivlen>` where ctx is obtained by
 * `ngtcp2_crypto_ctx_tls`.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_update_key(
  ngtcp2_conn *conn, uint8_t *rx_secret, uint8_t *tx_secret,
  ngtcp2_crypto_aead_ctx *rx_aead_ctx, uint8_t *rx_key, uint8_t *rx_iv,
  ngtcp2_crypto_aead_ctx *tx_aead_ctx, uint8_t *tx_key, uint8_t *tx_iv,
  const uint8_t *current_rx_secret, const uint8_t *current_tx_secret,
  size_t secretlen);

/**
 * @function
 *
 * `ngtcp2_crypto_update_key_cb` is a wrapper function around
 * `ngtcp2_crypto_update_key`.  It can be directly passed to
 * :member:`ngtcp2_callbacks.update_key` field.
 *
 * This function returns 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`.
 */
NGTCP2_EXTERN int ngtcp2_crypto_update_key_cb(
  ngtcp2_conn *conn, uint8_t *rx_secret, uint8_t *tx_secret,
  ngtcp2_crypto_aead_ctx *rx_aead_ctx, uint8_t *rx_iv,
  ngtcp2_crypto_aead_ctx *tx_aead_ctx, uint8_t *tx_iv,
  const uint8_t *current_rx_secret, const uint8_t *current_tx_secret,
  size_t secretlen, void *user_data);

/**
 * @function
 *
 * `ngtcp2_crypto_client_initial_cb` installs initial secrets and
 * encryption keys, and sets QUIC transport parameters.
 *
 * This function can be directly passed to
 * :member:`ngtcp2_callbacks.client_initial` field.  It is only used
 * by client.
 *
 * This function returns 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`.
 */
NGTCP2_EXTERN int ngtcp2_crypto_client_initial_cb(ngtcp2_conn *conn,
                                                  void *user_data);

/**
 * @function
 *
 * `ngtcp2_crypto_recv_retry_cb` re-installs initial secrets in
 * response to incoming Retry packet.
 *
 * This function can be directly passed to
 * :member:`ngtcp2_callbacks.recv_retry` field.  It is only used by
 * client.
 *
 * This function returns 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`.
 */
NGTCP2_EXTERN int ngtcp2_crypto_recv_retry_cb(ngtcp2_conn *conn,
                                              const ngtcp2_pkt_hd *hd,
                                              void *user_data);

/**
 * @function
 *
 * `ngtcp2_crypto_recv_client_initial_cb` installs initial secrets in
 * response to an incoming Initial packet from client, and sets QUIC
 * transport parameters.
 *
 * This function can be directly passed to
 * :member:`ngtcp2_callbacks.recv_client_initial` field.  It is only
 * used by server.
 *
 * This function returns 0 if it succeeds, or
 * :macro:`NGTCP2_ERR_CALLBACK_FAILURE`.
 */
NGTCP2_EXTERN int ngtcp2_crypto_recv_client_initial_cb(ngtcp2_conn *conn,
                                                       const ngtcp2_cid *dcid,
                                                       void *user_data);

/**
 * @function
 *
 * `ngtcp2_crypto_read_write_crypto_data` reads CRYPTO data |data| of
 * length |datalen| in an encryption level |encryption_level|, and may
 * feed outgoing CRYPTO data to |conn|.  This function can drive
 * handshake.  This function can be also used after handshake
 * completes.  It is allowed to call this function with |datalen| ==
 * 0.  In this case, no additional read operation is done.
 *
 * This function is implemented per TLS backend.  See
 * :ref:`tls-integration` for more details.
 *
 * This function returns 0 if it succeeds, or a negative error code.
 * The generic error code is -1 if a specific error code is not
 * suitable.  The error codes less than -10000 are specific to
 * underlying TLS implementation.  Refer to the implementation
 * specific header files for error codes.
 */
NGTCP2_EXTERN int
ngtcp2_crypto_read_write_crypto_data(ngtcp2_conn *conn,
                                     ngtcp2_encryption_level encryption_level,
                                     const uint8_t *data, size_t datalen);

/**
 * @function
 *
 * `ngtcp2_crypto_recv_crypto_data_cb` is a wrapper function around
 * `ngtcp2_crypto_read_write_crypto_data`.  It can be directly passed
 * to :member:`ngtcp2_callbacks.recv_crypto_data` field.
 *
 * For quictls and OpenSSL, the following error codes are treated as
 * success:
 *
 * - -10001 (e.g., :macro:`NGTCP2_CRYPTO_QUICTLS_ERR_TLS_WANT_X509_LOOKUP`)
 * - -10002 (e.g., :macro:`NGTCP2_CRYPTO_QUICTLS_ERR_TLS_WANT_CLIENT_HELLO_CB`)
 *
 * To continue the interrupted handshake, call
 * `ngtcp2_conn_continue_handshake`.
 *
 * See :ref:`tls-integration` for more details.
 *
 * If this function is used, the TLS implementation specific error
 * codes described in `ngtcp2_crypto_read_write_crypto_data` are
 * treated as if it returns -1 except for those that are listed above.
 * Do not use this function if an application wishes to use the TLS
 * implementation specific error codes.
 */
NGTCP2_EXTERN int ngtcp2_crypto_recv_crypto_data_cb(
  ngtcp2_conn *conn, ngtcp2_encryption_level encryption_level, uint64_t offset,
  const uint8_t *data, size_t datalen, void *user_data);

/**
 * @function
 *
 *  `ngtcp2_crypto_generate_stateless_reset_token` generates a
 *  stateless reset token using HKDF extraction using the given |cid|
 *  and |secret| as input.  The token will be written to the buffer
 *  pointed by |token|, and it must have a capacity of at least
 *  :macro:`NGTCP2_STATELESS_RESET_TOKENLEN` bytes.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_generate_stateless_reset_token(
  uint8_t *token, const uint8_t *secret, size_t secretlen,
  const ngtcp2_cid *cid);

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_TOKEN_RAND_DATALEN` is the length of random
 * data added to a token generated by
 * `ngtcp2_crypto_generate_retry_token` or
 * `ngtcp2_crypto_generate_regular_token`.
 */
#define NGTCP2_CRYPTO_TOKEN_RAND_DATALEN 16

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY` is the magic byte for
 * Retry token generated by `ngtcp2_crypto_generate_retry_token`.
 */
#define NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY 0xB6

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2` is the magic byte for
 * Retry token generated by `ngtcp2_crypto_generate_retry_token2`.
 */
#define NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2 0xB7

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_TOKEN_MAGIC_REGULAR` is the magic byte for a
 * token generated by `ngtcp2_crypto_generate_regular_token`.
 */
#define NGTCP2_CRYPTO_TOKEN_MAGIC_REGULAR 0x36

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN` is the maximum length of
 * a token generated by `ngtcp2_crypto_generate_retry_token`.
 */
#define NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN                                       \
  (/* magic = */ 1 + /* cid len = */ 1 + NGTCP2_MAX_CIDLEN +                   \
   sizeof(ngtcp2_tstamp) + /* aead tag = */ 16 +                               \
   NGTCP2_CRYPTO_TOKEN_RAND_DATALEN)

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2` is the maximum length of
 * a token generated by `ngtcp2_crypto_generate_retry_token2`.
 */
#define NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2                                      \
  (/* magic = */ 1 + sizeof(ngtcp2_sockaddr_union) + /* cid len = */ 1 +       \
   NGTCP2_MAX_CIDLEN + sizeof(ngtcp2_tstamp) + /* aead tag = */ 16 +           \
   NGTCP2_CRYPTO_TOKEN_RAND_DATALEN)

/**
 * @macro
 *
 * :macro:`NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN` is the maximum length
 * of a token generated by `ngtcp2_crypto_generate_regular_token`.
 * `ngtcp2_crypto_generate_regular_token2` generates a token of length
 * at most :macro:`NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN` bytes + the
 * length of the provided opaque data.
 */
#define NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN                                     \
  (/* magic = */ 1 + sizeof(ngtcp2_tstamp) + /* aead tag = */ 16 +             \
   NGTCP2_CRYPTO_TOKEN_RAND_DATALEN)

/**
 * @function
 *
 * `ngtcp2_crypto_generate_retry_token` generates a token in the
 * buffer pointed by |token| that is sent with Retry packet.  The
 * buffer pointed by |token| must have at least
 * :macro:`NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN` bytes long.  The
 * successfully generated token starts with
 * :macro:`NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY`.  |secret| of length
 * |secretlen| is a keying material to generate keys to encrypt the
 * token.  |version| is QUIC version.  |remote_addr| of length
 * |remote_addrlen| is an address of client.  |retry_scid| is a Source
 * Connection ID chosen by server, and set in Retry packet.  |odcid|
 * is a Destination Connection ID in Initial packet sent by client.
 * |ts| is the timestamp when the token is generated.
 *
 * See also `ngtcp2_crypto_generate_retry_token2`.
 *
 * This function returns the length of generated token if it succeeds,
 * or -1.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_crypto_generate_retry_token(
  uint8_t *token, const uint8_t *secret, size_t secretlen, uint32_t version,
  const ngtcp2_sockaddr *remote_addr, ngtcp2_socklen remote_addrlen,
  const ngtcp2_cid *retry_scid, const ngtcp2_cid *odcid, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_crypto_verify_retry_token` verifies Retry token stored in
 * the buffer pointed by |token| of length |tokenlen|.  |secret| of
 * length |secretlen| is a keying material to generate keys to decrypt
 * the token.  |version| is QUIC version of the Initial packet that
 * contains this token.  |remote_addr| of length |remote_addrlen| is
 * an address of client.  |dcid| is a Destination Connection ID in
 * Initial packet sent by client.  |timeout| is the period during
 * which the token is valid.  |ts| is the current timestamp.  When
 * validation succeeds, the extracted Destination Connection ID (which
 * is the Destination Connection ID in Initial packet sent by client
 * that triggered Retry packet) is stored in the buffer pointed by
 * |odcid|.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_verify_retry_token(
  ngtcp2_cid *odcid, const uint8_t *token, size_t tokenlen,
  const uint8_t *secret, size_t secretlen, uint32_t version,
  const ngtcp2_sockaddr *remote_addr, ngtcp2_socklen remote_addrlen,
  const ngtcp2_cid *dcid, ngtcp2_duration timeout, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_crypto_generate_retry_token2` generates a token in the
 * buffer pointed by |token| that is sent with Retry packet.  The
 * buffer pointed by |token| must have at least
 * :macro:`NGTCP2_CRYPTO_MAX_RETRY_TOKENLEN2` bytes long.  The
 * successfully generated token starts with
 * :macro:`NGTCP2_CRYPTO_TOKEN_MAGIC_RETRY2`.  |secret| of length
 * |secretlen| is a keying material to generate keys to encrypt the
 * token.  |version| is QUIC version.  |remote_addr| of length
 * |remote_addrlen| is an address of client.  |retry_scid| is a Source
 * Connection ID chosen by server, and set in Retry packet.  |odcid|
 * is a Destination Connection ID in Initial packet sent by client.
 * |ts| is the timestamp when the token is generated.
 *
 * Use this function instead of `ngtcp2_crypto_generate_retry_token`
 * if more detailed error handling is required when verifying the
 * token.  `ngtcp2_crypto_verify_retry_token2` must be used to verify
 * the token.
 *
 * This function returns the length of generated token if it succeeds,
 * or -1.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_crypto_generate_retry_token2(
  uint8_t *token, const uint8_t *secret, size_t secretlen, uint32_t version,
  const ngtcp2_sockaddr *remote_addr, ngtcp2_socklen remote_addrlen,
  const ngtcp2_cid *retry_scid, const ngtcp2_cid *odcid, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_crypto_verify_retry_token2` verifies Retry token stored in
 * the buffer pointed by |token| of length |tokenlen|.  |secret| of
 * length |secretlen| is a keying material to generate keys to decrypt
 * the token.  |version| is QUIC version of the Initial packet that
 * contains this token.  |remote_addr| of length |remote_addrlen| is
 * an address of client.  |dcid| is a Destination Connection ID in
 * Initial packet sent by client.  |timeout| is the period during
 * which the token is valid.  |ts| is the current timestamp.  When
 * validation succeeds, the extracted Destination Connection ID (which
 * is the Destination Connection ID in Initial packet sent by client
 * that triggered Retry packet) is stored in the buffer pointed by
 * |odcid|.
 *
 * The token must be generated by
 * `ngtcp2_crypto_generate_retry_token2`.
 *
 * This function returns 0 if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_CRYPTO_ERR_UNREADABLE_TOKEN`
 *     A token is badly formatted; or verifying the integrity
 *     protection failed.
 * :macro:`NGTCP2_CRYPTO_ERR_VERIFY_TOKEN`
 *     A token does not probe the client address; or the token
 *     validity has expired; or it contains invalid Connection ID.
 * :macro:`NGTCP2_CRYPTO_ERR_INTERNAL`
 *     Internal error occurred.
 */
NGTCP2_EXTERN int ngtcp2_crypto_verify_retry_token2(
  ngtcp2_cid *odcid, const uint8_t *token, size_t tokenlen,
  const uint8_t *secret, size_t secretlen, uint32_t version,
  const ngtcp2_sockaddr *remote_addr, ngtcp2_socklen remote_addrlen,
  const ngtcp2_cid *dcid, ngtcp2_duration timeout, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_crypto_generate_regular_token` generates a token in the
 * buffer pointed by |token| that is sent with NEW_TOKEN frame.  The
 * buffer pointed by |token| must have at least
 * :macro:`NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN` bytes long.  The
 * successfully generated token starts with
 * :macro:`NGTCP2_CRYPTO_TOKEN_MAGIC_REGULAR`.  |secret| of length
 * |secretlen| is a keying material to generate keys to encrypt the
 * token.  |remote_addr| of length |remote_addrlen| is an address of
 * client.  |ts| is the timestamp when the token is generated.
 *
 * This function returns the length of generated token if it succeeds,
 * or -1.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_crypto_generate_regular_token(
  uint8_t *token, const uint8_t *secret, size_t secretlen,
  const ngtcp2_sockaddr *remote_addr, ngtcp2_socklen remote_addrlen,
  ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_crypto_verify_regular_token` verifies a regular token
 * stored in the buffer pointed by |token| of length |tokenlen|.
 * |secret| of length |secretlen| is a keying material to generate
 * keys to decrypt the token.  |remote_addr| of length
 * |remote_addrlen| is an address of client.  |timeout| is the period
 * during which the token is valid.  |ts| is the current timestamp.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int ngtcp2_crypto_verify_regular_token(
  const uint8_t *token, size_t tokenlen, const uint8_t *secret,
  size_t secretlen, const ngtcp2_sockaddr *remote_addr,
  ngtcp2_socklen remote_addrlen, ngtcp2_duration timeout, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_crypto_generate_regular_token2` generates a token in the
 * buffer pointed by |token| that is sent with NEW_TOKEN frame.  The
 * buffer pointed by |token| must have at least
 * :macro:`NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN` + |datalen| bytes long.
 * The successfully generated token starts with
 * :macro:`NGTCP2_CRYPTO_TOKEN_MAGIC_REGULAR`.  |secret| of length
 * |secretlen| is a keying material to generate keys to encrypt the
 * token.  |remote_addr| of length |remote_addrlen| is an address of
 * client.  |ts| is the timestamp when the token is generated.  |data|
 * of length |datalen| is an opaque data embedded in the token.
 * |datalen| must be less than or equal to 256.
 *
 * Calling this function with |datalen| = 0 is equivalent to calling
 * `ngtcp2_crypto_generate_regular_token`.
 *
 * To get the opaque data after successful verification, use
 * `ngtcp2_crypto_verify_regular_token2`.
 * `ngtcp2_crypto_verify_regular_token` can verify the token with
 * |datalen| > 0, but it discards the opaque data.
 *
 * This function returns the length of generated token if it succeeds,
 * or -1.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_crypto_generate_regular_token2(
  uint8_t *token, const uint8_t *secret, size_t secretlen,
  const ngtcp2_sockaddr *remote_addr, ngtcp2_socklen remote_addrlen,
  const void *data, size_t datalen, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_crypto_verify_regular_token2` verifies a regular token
 * stored in the buffer pointed by |token| of length |tokenlen|.
 * |secret| of length |secretlen| is a keying material to generate
 * keys to decrypt the token.  |remote_addr| of length
 * |remote_addrlen| is an address of client.  |timeout| is the period
 * during which the token is valid.  |ts| is the current timestamp.
 * |data| is the pointer to the buffer of length at least
 * |max_datalen| bytes.  If the token is verified successfully, the
 * opaque data embedded in the token is copied to the buffer pointed
 * by |data|.
 *
 * If |tokenlen| is less than
 * :macro:`NGTCP2_CRYPTO_MAX_REGULAR_TOKENLEN`, this function returns
 * :macro:`NGTCP2_CRYPTO_ERR_UNREADABLE_TOKEN`.
 *
 * If the length of opaque data is larger than |max_datalen|, the
 * verification still succeeds, but nothing is written to the buffer
 * pointed by |data|, and this function returns 0.  In other words,
 * the opaque data is discarded.
 *
 * This function returns the number of the opaque data written to the
 * buffer pointed by |data| if it succeeds, or one of the following
 * negative error codes:
 *
 * :macro:`NGTCP2_CRYPTO_ERR_UNREADABLE_TOKEN`
 *     A token is badly formatted; or verifying the integrity
 *     protection failed.
 * :macro:`NGTCP2_CRYPTO_ERR_VERIFY_TOKEN`
 *     A token validity has expired.
 * :macro:`NGTCP2_CRYPTO_ERR_INTERNAL`
 *     Internal error occurred.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_crypto_verify_regular_token2(
  void *data, size_t max_datalen, const uint8_t *token, size_t tokenlen,
  const uint8_t *secret, size_t secretlen, const ngtcp2_sockaddr *remote_addr,
  ngtcp2_socklen remote_addrlen, ngtcp2_duration timeout, ngtcp2_tstamp ts);

/**
 * @function
 *
 * `ngtcp2_crypto_write_connection_close` writes Initial packet
 * containing CONNECTION_CLOSE with the given |error_code| and the
 * optional |reason| of length |reasonlen| to the buffer pointed by
 * |dest| of length |destlen|.  This function is designed for server
 * to close connection without committing the state when validating
 * Retry token fails.  This function must not be used by client.  The
 * |dcid| must be the Source Connection ID in Initial packet from
 * client.  The |scid| must be the Destination Connection ID in
 * Initial packet from client.  |scid| is used to derive initial
 * keying materials.
 *
 * This function wraps around `ngtcp2_pkt_write_connection_close` for
 * easier use.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_crypto_write_connection_close(
  uint8_t *dest, size_t destlen, uint32_t version, const ngtcp2_cid *dcid,
  const ngtcp2_cid *scid, uint64_t error_code, const uint8_t *reason,
  size_t reasonlen);

/**
 * @function
 *
 * `ngtcp2_crypto_write_retry` writes Retry packet to the buffer
 * pointed by |dest| of length |destlen|.  |dcid| is the Connection ID
 * which appeared in a packet as a Source Connection ID sent by
 * client.  |scid| is a server chosen Source Connection ID.  |odcid|
 * specifies Original Destination Connection ID which appeared in a
 * packet as a Destination Connection ID sent by client.  |token|
 * specifies Retry Token, and |tokenlen| specifies its length.
 *
 * This function wraps around `ngtcp2_pkt_write_retry` for easier use.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN ngtcp2_ssize ngtcp2_crypto_write_retry(
  uint8_t *dest, size_t destlen, uint32_t version, const ngtcp2_cid *dcid,
  const ngtcp2_cid *scid, const ngtcp2_cid *odcid, const uint8_t *token,
  size_t tokenlen);

/**
 * @function
 *
 * `ngtcp2_crypto_aead_ctx_encrypt_init` initializes |aead_ctx| with
 * new AEAD cipher context object for encryption which is constructed
 * to use |key| as encryption key.  |aead| specifies AEAD cipher to
 * use.  |noncelen| is the length of nonce.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int
ngtcp2_crypto_aead_ctx_encrypt_init(ngtcp2_crypto_aead_ctx *aead_ctx,
                                    const ngtcp2_crypto_aead *aead,
                                    const uint8_t *key, size_t noncelen);

/**
 * @function
 *
 * `ngtcp2_crypto_aead_ctx_decrypt_init` initializes |aead_ctx| with
 * new AEAD cipher context object for decryption which is constructed
 * to use |key| as decryption key.  |aead| specifies AEAD cipher to
 * use.  |noncelen| is the length of nonce.
 *
 * This function returns 0 if it succeeds, or -1.
 */
NGTCP2_EXTERN int
ngtcp2_crypto_aead_ctx_decrypt_init(ngtcp2_crypto_aead_ctx *aead_ctx,
                                    const ngtcp2_crypto_aead *aead,
                                    const uint8_t *key, size_t noncelen);

/**
 * @function
 *
 * `ngtcp2_crypto_aead_ctx_free` frees up resources used by
 * |aead_ctx|.  This function does not free the memory pointed by
 * |aead_ctx| itself.
 */
NGTCP2_EXTERN void
ngtcp2_crypto_aead_ctx_free(ngtcp2_crypto_aead_ctx *aead_ctx);

/**
 * @function
 *
 * `ngtcp2_crypto_delete_crypto_aead_ctx_cb` deletes the given
 * |aead_ctx|.
 *
 * This function can be directly passed to
 * :member:`ngtcp2_callbacks.delete_crypto_aead_ctx` field.
 */
NGTCP2_EXTERN void ngtcp2_crypto_delete_crypto_aead_ctx_cb(
  ngtcp2_conn *conn, ngtcp2_crypto_aead_ctx *aead_ctx, void *user_data);

/**
 * @function
 *
 * `ngtcp2_crypto_delete_crypto_cipher_ctx_cb` deletes the given
 * |cipher_ctx|.
 *
 * This function can be directly passed to
 * :member:`ngtcp2_callbacks.delete_crypto_cipher_ctx` field.
 */
NGTCP2_EXTERN void ngtcp2_crypto_delete_crypto_cipher_ctx_cb(
  ngtcp2_conn *conn, ngtcp2_crypto_cipher_ctx *cipher_ctx, void *user_data);

/**
 * @function
 *
 * `ngtcp2_crypto_get_path_challenge_data_cb` writes unpredictable
 * sequence of :macro:`NGTCP2_PATH_CHALLENGE_DATALEN` bytes to |data|
 * which is sent with PATH_CHALLENGE frame.
 *
 * This function can be directly passed to
 * :member:`ngtcp2_callbacks.get_path_challenge_data` field.
 *
 * Deprecated since v1.22.0.  Use
 * `ngtcp2_crypto_get_path_challenge_data2_cb` instead.
 */
NGTCP2_EXTERN int ngtcp2_crypto_get_path_challenge_data_cb(ngtcp2_conn *conn,
                                                           uint8_t *data,
                                                           void *user_data);

/**
 * @function
 *
 * `ngtcp2_crypto_get_path_challenge_data2_cb` writes unpredictable
 * sequence of :macro:`NGTCP2_PATH_CHALLENGE_DATALEN` bytes to |data|
 * which is sent with PATH_CHALLENGE frame.
 *
 * This function can be directly passed to
 * :member:`ngtcp2_callbacks.get_path_challenge_data2` field.
 *
 * This function has been available since v1.22.0.
 */
NGTCP2_EXTERN int ngtcp2_crypto_get_path_challenge_data2_cb(
  ngtcp2_conn *conn, ngtcp2_path_challenge_data *data, void *user_data);

/**
 * @function
 *
 * `ngtcp2_crypto_version_negotiation_cb` installs Initial keys for
 * |version| which is negotiated or being negotiated.  |client_dcid|
 * is the destination connection ID in first Initial packet from
 * client.
 *
 * This function can be directly passed to
 * :member:`ngtcp2_callbacks.version_negotiation` field.
 */
NGTCP2_EXTERN int
ngtcp2_crypto_version_negotiation_cb(ngtcp2_conn *conn, uint32_t version,
                                     const ngtcp2_cid *client_dcid,
                                     void *user_data);

typedef struct ngtcp2_crypto_conn_ref ngtcp2_crypto_conn_ref;

/**
 * @functypedef
 *
 * :type:`ngtcp2_crypto_get_conn` is a callback function to get a
 * pointer to :type:`ngtcp2_conn` from |conn_ref|.  The implementation
 * must return non-NULL :type:`ngtcp2_conn` object.
 */
typedef ngtcp2_conn *(*ngtcp2_crypto_get_conn)(
  ngtcp2_crypto_conn_ref *conn_ref);

/**
 * @struct
 *
 * :type:`ngtcp2_crypto_conn_ref` is a structure to get a pointer to
 * :type:`ngtcp2_conn`.  It is meant to be set to TLS native handle as
 * an application specific data (e.g. SSL_set_app_data in quictls).
 */
typedef struct ngtcp2_crypto_conn_ref {
  /**
   * :member:`get_conn` is a callback function to get a pointer to
   * :type:`ngtcp2_conn` object.
   */
  ngtcp2_crypto_get_conn get_conn;
  /**
   * :member:`user_data` is a pointer to arbitrary user data.
   */
  void *user_data;
} ngtcp2_crypto_conn_ref;

#ifdef __cplusplus
}
#endif /* defined(__cplusplus) */

#endif /* !defined(NGTCP2_CRYPTO_H) */
