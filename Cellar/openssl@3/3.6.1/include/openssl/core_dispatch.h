/*
 * Copyright 2019-2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_CORE_NUMBERS_H
#define OPENSSL_CORE_NUMBERS_H
#pragma once

#include <stdarg.h>
#include <openssl/core.h>
#include <openssl/indicator.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Generic function pointer for provider method arrays, or other contexts where
 * functions of various signatures must occupy a common slot in an array of
 * structures.
 */
typedef void (*OSSL_FUNC)(void);

/*-
 * Identities
 * ----------
 *
 * All series start with 1, to allow 0 to be an array terminator.
 * For any FUNC identity, we also provide a function signature typedef
 * and a static inline function to extract a function pointer from a
 * OSSL_DISPATCH element in a type safe manner.
 *
 * Names:
 * for any function base name 'foo' (uppercase form 'FOO'), we will have
 * the following:
 * - a macro for the identity with the name OSSL_FUNC_'FOO' or derivatives
 *   thereof (to be specified further down)
 * - a function signature typedef with the name OSSL_FUNC_'foo'_fn
 * - a function pointer extractor function with the name OSSL_FUNC_'foo'
 */

/*
 * Helper macro to create the function signature typedef and the extractor
 * |type| is the return-type of the function, |name| is the name of the
 * function to fetch, and |args| is a parenthesized list of parameters
 * for the function (that is, it is |name|'s function signature).
 * Note: This is considered a "reserved" internal macro. Applications should
 * not use this or assume its existence.
 */
#define OSSL_CORE_MAKE_FUNC(type, name, args)          \
    typedef type(OSSL_FUNC_##name##_fn) args;          \
    static ossl_unused ossl_inline                     \
        OSSL_FUNC_##name##_fn *                        \
        OSSL_FUNC_##name(const OSSL_DISPATCH *opf)     \
    {                                                  \
        return (OSSL_FUNC_##name##_fn *)opf->function; \
    }

/*
 * Core function identities, for the two OSSL_DISPATCH tables being passed
 * in the OSSL_provider_init call.
 *
 * 0 serves as a marker for the end of the OSSL_DISPATCH array, and must
 * therefore NEVER be used as a function identity.
 */
/* Functions provided by the Core to the provider, reserved numbers 1-1023 */
#define OSSL_FUNC_CORE_GETTABLE_PARAMS 1
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *,
    core_gettable_params, (const OSSL_CORE_HANDLE *prov))
#define OSSL_FUNC_CORE_GET_PARAMS 2
OSSL_CORE_MAKE_FUNC(int, core_get_params, (const OSSL_CORE_HANDLE *prov, OSSL_PARAM params[]))
#define OSSL_FUNC_CORE_THREAD_START 3
OSSL_CORE_MAKE_FUNC(int, core_thread_start, (const OSSL_CORE_HANDLE *prov, OSSL_thread_stop_handler_fn handfn, void *arg))
#define OSSL_FUNC_CORE_GET_LIBCTX 4
OSSL_CORE_MAKE_FUNC(OPENSSL_CORE_CTX *, core_get_libctx,
    (const OSSL_CORE_HANDLE *prov))
#define OSSL_FUNC_CORE_NEW_ERROR 5
OSSL_CORE_MAKE_FUNC(void, core_new_error, (const OSSL_CORE_HANDLE *prov))
#define OSSL_FUNC_CORE_SET_ERROR_DEBUG 6
OSSL_CORE_MAKE_FUNC(void, core_set_error_debug,
    (const OSSL_CORE_HANDLE *prov,
        const char *file, int line, const char *func))
#define OSSL_FUNC_CORE_VSET_ERROR 7
OSSL_CORE_MAKE_FUNC(void, core_vset_error,
    (const OSSL_CORE_HANDLE *prov,
        uint32_t reason, const char *fmt, va_list args))
#define OSSL_FUNC_CORE_SET_ERROR_MARK 8
OSSL_CORE_MAKE_FUNC(int, core_set_error_mark, (const OSSL_CORE_HANDLE *prov))
#define OSSL_FUNC_CORE_CLEAR_LAST_ERROR_MARK 9
OSSL_CORE_MAKE_FUNC(int, core_clear_last_error_mark,
    (const OSSL_CORE_HANDLE *prov))
#define OSSL_FUNC_CORE_POP_ERROR_TO_MARK 10
OSSL_CORE_MAKE_FUNC(int, core_pop_error_to_mark, (const OSSL_CORE_HANDLE *prov))

/* Functions to access the OBJ database */

#define OSSL_FUNC_CORE_OBJ_ADD_SIGID 11
#define OSSL_FUNC_CORE_OBJ_CREATE 12

OSSL_CORE_MAKE_FUNC(int, core_obj_add_sigid,
    (const OSSL_CORE_HANDLE *prov, const char *sign_name,
        const char *digest_name, const char *pkey_name))
OSSL_CORE_MAKE_FUNC(int, core_obj_create,
    (const OSSL_CORE_HANDLE *prov, const char *oid,
        const char *sn, const char *ln))

/* Memory allocation, freeing, clearing. */
#define OSSL_FUNC_CRYPTO_MALLOC 20
OSSL_CORE_MAKE_FUNC(void *,
    CRYPTO_malloc, (size_t num, const char *file, int line))
#define OSSL_FUNC_CRYPTO_ZALLOC 21
OSSL_CORE_MAKE_FUNC(void *,
    CRYPTO_zalloc, (size_t num, const char *file, int line))
#define OSSL_FUNC_CRYPTO_FREE 22
OSSL_CORE_MAKE_FUNC(void,
    CRYPTO_free, (void *ptr, const char *file, int line))
#define OSSL_FUNC_CRYPTO_CLEAR_FREE 23
OSSL_CORE_MAKE_FUNC(void,
    CRYPTO_clear_free, (void *ptr, size_t num, const char *file, int line))
#define OSSL_FUNC_CRYPTO_REALLOC 24
OSSL_CORE_MAKE_FUNC(void *,
    CRYPTO_realloc, (void *addr, size_t num, const char *file, int line))
#define OSSL_FUNC_CRYPTO_CLEAR_REALLOC 25
OSSL_CORE_MAKE_FUNC(void *,
    CRYPTO_clear_realloc, (void *addr, size_t old_num, size_t num, const char *file, int line))
#define OSSL_FUNC_CRYPTO_SECURE_MALLOC 26
OSSL_CORE_MAKE_FUNC(void *,
    CRYPTO_secure_malloc, (size_t num, const char *file, int line))
#define OSSL_FUNC_CRYPTO_SECURE_ZALLOC 27
OSSL_CORE_MAKE_FUNC(void *,
    CRYPTO_secure_zalloc, (size_t num, const char *file, int line))
#define OSSL_FUNC_CRYPTO_SECURE_FREE 28
OSSL_CORE_MAKE_FUNC(void,
    CRYPTO_secure_free, (void *ptr, const char *file, int line))
#define OSSL_FUNC_CRYPTO_SECURE_CLEAR_FREE 29
OSSL_CORE_MAKE_FUNC(void,
    CRYPTO_secure_clear_free, (void *ptr, size_t num, const char *file, int line))
#define OSSL_FUNC_CRYPTO_SECURE_ALLOCATED 30
OSSL_CORE_MAKE_FUNC(int,
    CRYPTO_secure_allocated, (const void *ptr))
#define OSSL_FUNC_OPENSSL_CLEANSE 31
OSSL_CORE_MAKE_FUNC(void,
    OPENSSL_cleanse, (void *ptr, size_t len))

/* Bio functions provided by the core */
#define OSSL_FUNC_BIO_NEW_FILE 40
#define OSSL_FUNC_BIO_NEW_MEMBUF 41
#define OSSL_FUNC_BIO_READ_EX 42
#define OSSL_FUNC_BIO_WRITE_EX 43
#define OSSL_FUNC_BIO_UP_REF 44
#define OSSL_FUNC_BIO_FREE 45
#define OSSL_FUNC_BIO_VPRINTF 46
#define OSSL_FUNC_BIO_VSNPRINTF 47
#define OSSL_FUNC_BIO_PUTS 48
#define OSSL_FUNC_BIO_GETS 49
#define OSSL_FUNC_BIO_CTRL 50

OSSL_CORE_MAKE_FUNC(OSSL_CORE_BIO *, BIO_new_file, (const char *filename, const char *mode))
OSSL_CORE_MAKE_FUNC(OSSL_CORE_BIO *, BIO_new_membuf, (const void *buf, int len))
OSSL_CORE_MAKE_FUNC(int, BIO_read_ex, (OSSL_CORE_BIO * bio, void *data, size_t data_len, size_t *bytes_read))
OSSL_CORE_MAKE_FUNC(int, BIO_write_ex, (OSSL_CORE_BIO * bio, const void *data, size_t data_len, size_t *written))
OSSL_CORE_MAKE_FUNC(int, BIO_gets, (OSSL_CORE_BIO * bio, char *buf, int size))
OSSL_CORE_MAKE_FUNC(int, BIO_puts, (OSSL_CORE_BIO * bio, const char *str))
OSSL_CORE_MAKE_FUNC(int, BIO_up_ref, (OSSL_CORE_BIO * bio))
OSSL_CORE_MAKE_FUNC(int, BIO_free, (OSSL_CORE_BIO * bio))
OSSL_CORE_MAKE_FUNC(int, BIO_vprintf, (OSSL_CORE_BIO * bio, const char *format, va_list args))
OSSL_CORE_MAKE_FUNC(int, BIO_vsnprintf,
    (char *buf, size_t n, const char *fmt, va_list args))
OSSL_CORE_MAKE_FUNC(int, BIO_ctrl, (OSSL_CORE_BIO * bio, int cmd, long num, void *ptr))

/* New seeding functions prototypes with the 101-104 series */
#define OSSL_FUNC_CLEANUP_USER_ENTROPY 96
#define OSSL_FUNC_CLEANUP_USER_NONCE 97
#define OSSL_FUNC_GET_USER_ENTROPY 98
#define OSSL_FUNC_GET_USER_NONCE 99

#define OSSL_FUNC_INDICATOR_CB 95
OSSL_CORE_MAKE_FUNC(void, indicator_cb, (OPENSSL_CORE_CTX * ctx, OSSL_INDICATOR_CALLBACK **cb))
#define OSSL_FUNC_SELF_TEST_CB 100
OSSL_CORE_MAKE_FUNC(void, self_test_cb, (OPENSSL_CORE_CTX * ctx, OSSL_CALLBACK **cb, void **cbarg))

/* Functions to get seed material from the operating system */
#define OSSL_FUNC_GET_ENTROPY 101
#define OSSL_FUNC_CLEANUP_ENTROPY 102
#define OSSL_FUNC_GET_NONCE 103
#define OSSL_FUNC_CLEANUP_NONCE 104
OSSL_CORE_MAKE_FUNC(size_t, get_entropy, (const OSSL_CORE_HANDLE *handle, unsigned char **pout, int entropy, size_t min_len, size_t max_len))
OSSL_CORE_MAKE_FUNC(size_t, get_user_entropy, (const OSSL_CORE_HANDLE *handle, unsigned char **pout, int entropy, size_t min_len, size_t max_len))
OSSL_CORE_MAKE_FUNC(void, cleanup_entropy, (const OSSL_CORE_HANDLE *handle, unsigned char *buf, size_t len))
OSSL_CORE_MAKE_FUNC(void, cleanup_user_entropy, (const OSSL_CORE_HANDLE *handle, unsigned char *buf, size_t len))
OSSL_CORE_MAKE_FUNC(size_t, get_nonce, (const OSSL_CORE_HANDLE *handle, unsigned char **pout, size_t min_len, size_t max_len, const void *salt, size_t salt_len))
OSSL_CORE_MAKE_FUNC(size_t, get_user_nonce, (const OSSL_CORE_HANDLE *handle, unsigned char **pout, size_t min_len, size_t max_len, const void *salt, size_t salt_len))
OSSL_CORE_MAKE_FUNC(void, cleanup_nonce, (const OSSL_CORE_HANDLE *handle, unsigned char *buf, size_t len))
OSSL_CORE_MAKE_FUNC(void, cleanup_user_nonce, (const OSSL_CORE_HANDLE *handle, unsigned char *buf, size_t len))

/* Functions to access the core's providers */
#define OSSL_FUNC_PROVIDER_REGISTER_CHILD_CB 105
#define OSSL_FUNC_PROVIDER_DEREGISTER_CHILD_CB 106
#define OSSL_FUNC_PROVIDER_NAME 107
#define OSSL_FUNC_PROVIDER_GET0_PROVIDER_CTX 108
#define OSSL_FUNC_PROVIDER_GET0_DISPATCH 109
#define OSSL_FUNC_PROVIDER_UP_REF 110
#define OSSL_FUNC_PROVIDER_FREE 111

OSSL_CORE_MAKE_FUNC(int, provider_register_child_cb,
    (const OSSL_CORE_HANDLE *handle,
        int (*create_cb)(const OSSL_CORE_HANDLE *provider, void *cbdata),
        int (*remove_cb)(const OSSL_CORE_HANDLE *provider, void *cbdata),
        int (*global_props_cb)(const char *props, void *cbdata),
        void *cbdata))
OSSL_CORE_MAKE_FUNC(void, provider_deregister_child_cb,
    (const OSSL_CORE_HANDLE *handle))
OSSL_CORE_MAKE_FUNC(const char *, provider_name,
    (const OSSL_CORE_HANDLE *prov))
OSSL_CORE_MAKE_FUNC(void *, provider_get0_provider_ctx,
    (const OSSL_CORE_HANDLE *prov))
OSSL_CORE_MAKE_FUNC(const OSSL_DISPATCH *, provider_get0_dispatch,
    (const OSSL_CORE_HANDLE *prov))
OSSL_CORE_MAKE_FUNC(int, provider_up_ref,
    (const OSSL_CORE_HANDLE *prov, int activate))
OSSL_CORE_MAKE_FUNC(int, provider_free,
    (const OSSL_CORE_HANDLE *prov, int deactivate))

/* Additional error functions provided by the core */
#define OSSL_FUNC_CORE_COUNT_TO_MARK 120
OSSL_CORE_MAKE_FUNC(int, core_count_to_mark, (const OSSL_CORE_HANDLE *prov))

/* Functions provided by the provider to the Core, reserved numbers 1024-1535 */
#define OSSL_FUNC_PROVIDER_TEARDOWN 1024
OSSL_CORE_MAKE_FUNC(void, provider_teardown, (void *provctx))
#define OSSL_FUNC_PROVIDER_GETTABLE_PARAMS 1025
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *,
    provider_gettable_params, (void *provctx))
#define OSSL_FUNC_PROVIDER_GET_PARAMS 1026
OSSL_CORE_MAKE_FUNC(int, provider_get_params, (void *provctx, OSSL_PARAM params[]))
#define OSSL_FUNC_PROVIDER_QUERY_OPERATION 1027
OSSL_CORE_MAKE_FUNC(const OSSL_ALGORITHM *, provider_query_operation,
    (void *provctx, int operation_id, int *no_store))
#define OSSL_FUNC_PROVIDER_UNQUERY_OPERATION 1028
OSSL_CORE_MAKE_FUNC(void, provider_unquery_operation,
    (void *provctx, int operation_id, const OSSL_ALGORITHM *))
#define OSSL_FUNC_PROVIDER_GET_REASON_STRINGS 1029
OSSL_CORE_MAKE_FUNC(const OSSL_ITEM *, provider_get_reason_strings,
    (void *provctx))
#define OSSL_FUNC_PROVIDER_GET_CAPABILITIES 1030
OSSL_CORE_MAKE_FUNC(int, provider_get_capabilities, (void *provctx, const char *capability, OSSL_CALLBACK *cb, void *arg))
#define OSSL_FUNC_PROVIDER_SELF_TEST 1031
OSSL_CORE_MAKE_FUNC(int, provider_self_test, (void *provctx))
#define OSSL_FUNC_PROVIDER_RANDOM_BYTES 1032
OSSL_CORE_MAKE_FUNC(int, provider_random_bytes, (void *provctx, int which, void *buf, size_t n, unsigned int strength))

/* Libssl related functions */
#define OSSL_FUNC_SSL_QUIC_TLS_CRYPTO_SEND 2001
OSSL_CORE_MAKE_FUNC(int, SSL_QUIC_TLS_crypto_send,
    (SSL * s, const unsigned char *buf, size_t buf_len,
        size_t *consumed, void *arg))
#define OSSL_FUNC_SSL_QUIC_TLS_CRYPTO_RECV_RCD 2002
OSSL_CORE_MAKE_FUNC(int, SSL_QUIC_TLS_crypto_recv_rcd,
    (SSL * s, const unsigned char **buf, size_t *bytes_read,
        void *arg))
#define OSSL_FUNC_SSL_QUIC_TLS_CRYPTO_RELEASE_RCD 2003
OSSL_CORE_MAKE_FUNC(int, SSL_QUIC_TLS_crypto_release_rcd,
    (SSL * s, size_t bytes_read, void *arg))
#define OSSL_FUNC_SSL_QUIC_TLS_YIELD_SECRET 2004
OSSL_CORE_MAKE_FUNC(int, SSL_QUIC_TLS_yield_secret,
    (SSL * s, uint32_t prot_level, int direction,
        const unsigned char *secret, size_t secret_len, void *arg))
#define OSSL_FUNC_SSL_QUIC_TLS_GOT_TRANSPORT_PARAMS 2005
OSSL_CORE_MAKE_FUNC(int, SSL_QUIC_TLS_got_transport_params,
    (SSL * s, const unsigned char *params, size_t params_len,
        void *arg))
#define OSSL_FUNC_SSL_QUIC_TLS_ALERT 2006
OSSL_CORE_MAKE_FUNC(int, SSL_QUIC_TLS_alert,
    (SSL * s, unsigned char alert_code, void *arg))

/* Operations */

#define OSSL_OP_DIGEST 1
#define OSSL_OP_CIPHER 2 /* Symmetric Ciphers */
#define OSSL_OP_MAC 3
#define OSSL_OP_KDF 4
#define OSSL_OP_RAND 5
#define OSSL_OP_KEYMGMT 10
#define OSSL_OP_KEYEXCH 11
#define OSSL_OP_SIGNATURE 12
#define OSSL_OP_ASYM_CIPHER 13
#define OSSL_OP_KEM 14
#define OSSL_OP_SKEYMGMT 15
/* New section for non-EVP operations */
#define OSSL_OP_ENCODER 20
#define OSSL_OP_DECODER 21
#define OSSL_OP_STORE 22
/* Highest known operation number */
#define OSSL_OP__HIGHEST 22

/* Digests */

#define OSSL_FUNC_DIGEST_NEWCTX 1
#define OSSL_FUNC_DIGEST_INIT 2
#define OSSL_FUNC_DIGEST_UPDATE 3
#define OSSL_FUNC_DIGEST_FINAL 4
#define OSSL_FUNC_DIGEST_DIGEST 5
#define OSSL_FUNC_DIGEST_FREECTX 6
#define OSSL_FUNC_DIGEST_DUPCTX 7
#define OSSL_FUNC_DIGEST_GET_PARAMS 8
#define OSSL_FUNC_DIGEST_SET_CTX_PARAMS 9
#define OSSL_FUNC_DIGEST_GET_CTX_PARAMS 10
#define OSSL_FUNC_DIGEST_GETTABLE_PARAMS 11
#define OSSL_FUNC_DIGEST_SETTABLE_CTX_PARAMS 12
#define OSSL_FUNC_DIGEST_GETTABLE_CTX_PARAMS 13
#define OSSL_FUNC_DIGEST_SQUEEZE 14
#define OSSL_FUNC_DIGEST_COPYCTX 15

OSSL_CORE_MAKE_FUNC(void *, digest_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(int, digest_init, (void *dctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, digest_update,
    (void *dctx, const unsigned char *in, size_t inl))
OSSL_CORE_MAKE_FUNC(int, digest_final,
    (void *dctx,
        unsigned char *out, size_t *outl, size_t outsz))
OSSL_CORE_MAKE_FUNC(int, digest_squeeze,
    (void *dctx,
        unsigned char *out, size_t *outl, size_t outsz))
OSSL_CORE_MAKE_FUNC(int, digest_digest,
    (void *provctx, const unsigned char *in, size_t inl,
        unsigned char *out, size_t *outl, size_t outsz))

OSSL_CORE_MAKE_FUNC(void, digest_freectx, (void *dctx))
OSSL_CORE_MAKE_FUNC(void *, digest_dupctx, (void *dctx))
OSSL_CORE_MAKE_FUNC(void, digest_copyctx, (void *outctx, void *inctx))

OSSL_CORE_MAKE_FUNC(int, digest_get_params, (OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, digest_set_ctx_params,
    (void *vctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, digest_get_ctx_params,
    (void *vctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, digest_gettable_params,
    (void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, digest_settable_ctx_params,
    (void *dctx, void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, digest_gettable_ctx_params,
    (void *dctx, void *provctx))

/* Symmetric Ciphers */

#define OSSL_FUNC_CIPHER_NEWCTX 1
#define OSSL_FUNC_CIPHER_ENCRYPT_INIT 2
#define OSSL_FUNC_CIPHER_DECRYPT_INIT 3
#define OSSL_FUNC_CIPHER_UPDATE 4
#define OSSL_FUNC_CIPHER_FINAL 5
#define OSSL_FUNC_CIPHER_CIPHER 6
#define OSSL_FUNC_CIPHER_FREECTX 7
#define OSSL_FUNC_CIPHER_DUPCTX 8
#define OSSL_FUNC_CIPHER_GET_PARAMS 9
#define OSSL_FUNC_CIPHER_GET_CTX_PARAMS 10
#define OSSL_FUNC_CIPHER_SET_CTX_PARAMS 11
#define OSSL_FUNC_CIPHER_GETTABLE_PARAMS 12
#define OSSL_FUNC_CIPHER_GETTABLE_CTX_PARAMS 13
#define OSSL_FUNC_CIPHER_SETTABLE_CTX_PARAMS 14
#define OSSL_FUNC_CIPHER_PIPELINE_ENCRYPT_INIT 15
#define OSSL_FUNC_CIPHER_PIPELINE_DECRYPT_INIT 16
#define OSSL_FUNC_CIPHER_PIPELINE_UPDATE 17
#define OSSL_FUNC_CIPHER_PIPELINE_FINAL 18
#define OSSL_FUNC_CIPHER_ENCRYPT_SKEY_INIT 19
#define OSSL_FUNC_CIPHER_DECRYPT_SKEY_INIT 20

OSSL_CORE_MAKE_FUNC(void *, cipher_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(int, cipher_encrypt_init, (void *cctx, const unsigned char *key, size_t keylen, const unsigned char *iv, size_t ivlen, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, cipher_decrypt_init, (void *cctx, const unsigned char *key, size_t keylen, const unsigned char *iv, size_t ivlen, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, cipher_update,
    (void *cctx,
        unsigned char *out, size_t *outl, size_t outsize,
        const unsigned char *in, size_t inl))
OSSL_CORE_MAKE_FUNC(int, cipher_final,
    (void *cctx,
        unsigned char *out, size_t *outl, size_t outsize))
OSSL_CORE_MAKE_FUNC(int, cipher_cipher,
    (void *cctx,
        unsigned char *out, size_t *outl, size_t outsize,
        const unsigned char *in, size_t inl))
OSSL_CORE_MAKE_FUNC(int, cipher_pipeline_encrypt_init,
    (void *cctx,
        const unsigned char *key, size_t keylen,
        size_t numpipes, const unsigned char **iv, size_t ivlen,
        const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, cipher_pipeline_decrypt_init,
    (void *cctx,
        const unsigned char *key, size_t keylen,
        size_t numpipes, const unsigned char **iv, size_t ivlen,
        const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, cipher_pipeline_update,
    (void *cctx, size_t numpipes,
        unsigned char **out, size_t *outl, const size_t *outsize,
        const unsigned char **in, const size_t *inl))
OSSL_CORE_MAKE_FUNC(int, cipher_pipeline_final,
    (void *cctx, size_t numpipes,
        unsigned char **out, size_t *outl, const size_t *outsize))
OSSL_CORE_MAKE_FUNC(void, cipher_freectx, (void *cctx))
OSSL_CORE_MAKE_FUNC(void *, cipher_dupctx, (void *cctx))
OSSL_CORE_MAKE_FUNC(int, cipher_get_params, (OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, cipher_get_ctx_params, (void *cctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, cipher_set_ctx_params, (void *cctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, cipher_gettable_params,
    (void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, cipher_settable_ctx_params,
    (void *cctx, void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, cipher_gettable_ctx_params,
    (void *cctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, cipher_encrypt_skey_init, (void *cctx, void *skeydata, const unsigned char *iv, size_t ivlen, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, cipher_decrypt_skey_init, (void *cctx, void *skeydata, const unsigned char *iv, size_t ivlen, const OSSL_PARAM params[]))

/* MACs */

#define OSSL_FUNC_MAC_NEWCTX 1
#define OSSL_FUNC_MAC_DUPCTX 2
#define OSSL_FUNC_MAC_FREECTX 3
#define OSSL_FUNC_MAC_INIT 4
#define OSSL_FUNC_MAC_UPDATE 5
#define OSSL_FUNC_MAC_FINAL 6
#define OSSL_FUNC_MAC_GET_PARAMS 7
#define OSSL_FUNC_MAC_GET_CTX_PARAMS 8
#define OSSL_FUNC_MAC_SET_CTX_PARAMS 9
#define OSSL_FUNC_MAC_GETTABLE_PARAMS 10
#define OSSL_FUNC_MAC_GETTABLE_CTX_PARAMS 11
#define OSSL_FUNC_MAC_SETTABLE_CTX_PARAMS 12
#define OSSL_FUNC_MAC_INIT_SKEY 13

OSSL_CORE_MAKE_FUNC(void *, mac_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(void *, mac_dupctx, (void *src))
OSSL_CORE_MAKE_FUNC(void, mac_freectx, (void *mctx))
OSSL_CORE_MAKE_FUNC(int, mac_init, (void *mctx, const unsigned char *key, size_t keylen, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, mac_update,
    (void *mctx, const unsigned char *in, size_t inl))
OSSL_CORE_MAKE_FUNC(int, mac_final,
    (void *mctx,
        unsigned char *out, size_t *outl, size_t outsize))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, mac_gettable_params, (void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, mac_gettable_ctx_params,
    (void *mctx, void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, mac_settable_ctx_params,
    (void *mctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, mac_get_params, (OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, mac_get_ctx_params,
    (void *mctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, mac_set_ctx_params,
    (void *mctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, mac_init_skey, (void *mctx, void *key, const OSSL_PARAM params[]))

/*-
 * Symmetric key management
 *
 * The Key Management takes care of provider side of symmetric key objects, and
 * includes essentially everything that manipulates the keys  themselves and
 * their parameters.
 *
 * The key objects are commonly referred to as |keydata|, and it MUST be able
 * to contain parameters if the key has any, and the secret key.
 *
 * Key objects are created with OSSL_FUNC_skeymgmt_import() (there is no
 * dedicated memory allocation function), exported with
 * OSSL_FUNC_skeymgmt_export() and destroyed with OSSL_FUNC_keymgmt_free().
 *
 */

/* Key data subset selection - individual bits */
#define OSSL_SKEYMGMT_SELECT_PARAMETERS 0x01
#define OSSL_SKEYMGMT_SELECT_SECRET_KEY 0x02

/* Key data subset selection - combinations */
#define OSSL_SKEYMGMT_SELECT_ALL \
    (OSSL_SKEYMGMT_SELECT_PARAMETERS | OSSL_SKEYMGMT_SELECT_SECRET_KEY)

#define OSSL_FUNC_SKEYMGMT_FREE 1
#define OSSL_FUNC_SKEYMGMT_IMPORT 2
#define OSSL_FUNC_SKEYMGMT_EXPORT 3
#define OSSL_FUNC_SKEYMGMT_GENERATE 4
#define OSSL_FUNC_SKEYMGMT_GET_KEY_ID 5
#define OSSL_FUNC_SKEYMGMT_IMP_SETTABLE_PARAMS 6
#define OSSL_FUNC_SKEYMGMT_GEN_SETTABLE_PARAMS 7

OSSL_CORE_MAKE_FUNC(void, skeymgmt_free, (void *keydata))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *,
    skeymgmt_imp_settable_params, (void *provctx))
OSSL_CORE_MAKE_FUNC(void *, skeymgmt_import, (void *provctx, int selection, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, skeymgmt_export,
    (void *keydata, int selection,
        OSSL_CALLBACK *param_cb, void *cbarg))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *,
    skeymgmt_gen_settable_params, (void *provctx))
OSSL_CORE_MAKE_FUNC(void *, skeymgmt_generate, (void *provctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const char *, skeymgmt_get_key_id, (void *keydata))

/* KDFs and PRFs */

#define OSSL_FUNC_KDF_NEWCTX 1
#define OSSL_FUNC_KDF_DUPCTX 2
#define OSSL_FUNC_KDF_FREECTX 3
#define OSSL_FUNC_KDF_RESET 4
#define OSSL_FUNC_KDF_DERIVE 5
#define OSSL_FUNC_KDF_GETTABLE_PARAMS 6
#define OSSL_FUNC_KDF_GETTABLE_CTX_PARAMS 7
#define OSSL_FUNC_KDF_SETTABLE_CTX_PARAMS 8
#define OSSL_FUNC_KDF_GET_PARAMS 9
#define OSSL_FUNC_KDF_GET_CTX_PARAMS 10
#define OSSL_FUNC_KDF_SET_CTX_PARAMS 11
#define OSSL_FUNC_KDF_SET_SKEY 12
#define OSSL_FUNC_KDF_DERIVE_SKEY 13

OSSL_CORE_MAKE_FUNC(void *, kdf_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(void *, kdf_dupctx, (void *src))
OSSL_CORE_MAKE_FUNC(void, kdf_freectx, (void *kctx))
OSSL_CORE_MAKE_FUNC(void, kdf_reset, (void *kctx))
OSSL_CORE_MAKE_FUNC(int, kdf_derive, (void *kctx, unsigned char *key, size_t keylen, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, kdf_gettable_params, (void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, kdf_gettable_ctx_params,
    (void *kctx, void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, kdf_settable_ctx_params,
    (void *kctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, kdf_get_params, (OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, kdf_get_ctx_params,
    (void *kctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, kdf_set_ctx_params,
    (void *kctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, kdf_set_skey,
    (void *kctx, void *skeydata, const char *paramname))
OSSL_CORE_MAKE_FUNC(void *, kdf_derive_skey, (void *ctx, const char *key_type, void *provctx, OSSL_FUNC_skeymgmt_import_fn *import, size_t keylen, const OSSL_PARAM params[]))

/* RAND */

#define OSSL_FUNC_RAND_NEWCTX 1
#define OSSL_FUNC_RAND_FREECTX 2
#define OSSL_FUNC_RAND_INSTANTIATE 3
#define OSSL_FUNC_RAND_UNINSTANTIATE 4
#define OSSL_FUNC_RAND_GENERATE 5
#define OSSL_FUNC_RAND_RESEED 6
#define OSSL_FUNC_RAND_NONCE 7
#define OSSL_FUNC_RAND_ENABLE_LOCKING 8
#define OSSL_FUNC_RAND_LOCK 9
#define OSSL_FUNC_RAND_UNLOCK 10
#define OSSL_FUNC_RAND_GETTABLE_PARAMS 11
#define OSSL_FUNC_RAND_GETTABLE_CTX_PARAMS 12
#define OSSL_FUNC_RAND_SETTABLE_CTX_PARAMS 13
#define OSSL_FUNC_RAND_GET_PARAMS 14
#define OSSL_FUNC_RAND_GET_CTX_PARAMS 15
#define OSSL_FUNC_RAND_SET_CTX_PARAMS 16
#define OSSL_FUNC_RAND_VERIFY_ZEROIZATION 17
#define OSSL_FUNC_RAND_GET_SEED 18
#define OSSL_FUNC_RAND_CLEAR_SEED 19

OSSL_CORE_MAKE_FUNC(void *, rand_newctx,
    (void *provctx, void *parent,
        const OSSL_DISPATCH *parent_calls))
OSSL_CORE_MAKE_FUNC(void, rand_freectx, (void *vctx))
OSSL_CORE_MAKE_FUNC(int, rand_instantiate,
    (void *vdrbg, unsigned int strength,
        int prediction_resistance,
        const unsigned char *pstr, size_t pstr_len,
        const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, rand_uninstantiate, (void *vdrbg))
OSSL_CORE_MAKE_FUNC(int, rand_generate,
    (void *vctx, unsigned char *out, size_t outlen,
        unsigned int strength, int prediction_resistance,
        const unsigned char *addin, size_t addin_len))
OSSL_CORE_MAKE_FUNC(int, rand_reseed,
    (void *vctx, int prediction_resistance,
        const unsigned char *ent, size_t ent_len,
        const unsigned char *addin, size_t addin_len))
OSSL_CORE_MAKE_FUNC(size_t, rand_nonce,
    (void *vctx, unsigned char *out, unsigned int strength,
        size_t min_noncelen, size_t max_noncelen))
OSSL_CORE_MAKE_FUNC(int, rand_enable_locking, (void *vctx))
OSSL_CORE_MAKE_FUNC(int, rand_lock, (void *vctx))
OSSL_CORE_MAKE_FUNC(void, rand_unlock, (void *vctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, rand_gettable_params, (void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, rand_gettable_ctx_params,
    (void *vctx, void *provctx))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, rand_settable_ctx_params,
    (void *vctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, rand_get_params, (OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, rand_get_ctx_params,
    (void *vctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, rand_set_ctx_params,
    (void *vctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(void, rand_set_callbacks,
    (void *vctx, OSSL_INOUT_CALLBACK *get_entropy,
        OSSL_CALLBACK *cleanup_entropy,
        OSSL_INOUT_CALLBACK *get_nonce,
        OSSL_CALLBACK *cleanup_nonce, void *arg))
OSSL_CORE_MAKE_FUNC(int, rand_verify_zeroization,
    (void *vctx))
OSSL_CORE_MAKE_FUNC(size_t, rand_get_seed,
    (void *vctx, unsigned char **buffer,
        int entropy, size_t min_len, size_t max_len,
        int prediction_resistance,
        const unsigned char *adin, size_t adin_len))
OSSL_CORE_MAKE_FUNC(void, rand_clear_seed,
    (void *vctx, unsigned char *buffer, size_t b_len))

/*-
 * Key management
 *
 * The Key Management takes care of provider side key objects, and includes
 * all current functionality to create them, destroy them, set parameters
 * and key material, etc, essentially everything that manipulates the keys
 * themselves and their parameters.
 *
 * The key objects are commonly referred to as |keydata|, and it MUST be able
 * to contain parameters if the key has any, the public key and the private
 * key.  All parts are optional, but their presence determines what can be
 * done with the key object in terms of encryption, signature, and so on.
 * The assumption from libcrypto is that the key object contains any of the
 * following data combinations:
 *
 * - parameters only
 * - public key only
 * - public key + private key
 * - parameters + public key
 * - parameters + public key + private key
 *
 * What "parameters", "public key" and "private key" means in detail is left
 * to the implementation.  In the case of DH and DSA, they would typically
 * include domain parameters, while for certain variants of RSA, they would
 * typically include PSS or OAEP parameters.
 *
 * Key objects are created with OSSL_FUNC_keymgmt_new() and destroyed with
 * OSSL_FUNC_keymgmt_free().  Key objects can have data filled in with
 * OSSL_FUNC_keymgmt_import().
 *
 * Three functions are made available to check what selection of data is
 * present in a key object: OSSL_FUNC_keymgmt_has_parameters(),
 * OSSL_FUNC_keymgmt_has_public_key(), and OSSL_FUNC_keymgmt_has_private_key(),
 */

/* Key data subset selection - individual bits */
#define OSSL_KEYMGMT_SELECT_PRIVATE_KEY 0x01
#define OSSL_KEYMGMT_SELECT_PUBLIC_KEY 0x02
#define OSSL_KEYMGMT_SELECT_DOMAIN_PARAMETERS 0x04
#define OSSL_KEYMGMT_SELECT_OTHER_PARAMETERS 0x80

/* Key data subset selection - combinations */
#define OSSL_KEYMGMT_SELECT_ALL_PARAMETERS \
    (OSSL_KEYMGMT_SELECT_DOMAIN_PARAMETERS \
        | OSSL_KEYMGMT_SELECT_OTHER_PARAMETERS)
#define OSSL_KEYMGMT_SELECT_KEYPAIR \
    (OSSL_KEYMGMT_SELECT_PRIVATE_KEY | OSSL_KEYMGMT_SELECT_PUBLIC_KEY)
#define OSSL_KEYMGMT_SELECT_ALL \
    (OSSL_KEYMGMT_SELECT_KEYPAIR | OSSL_KEYMGMT_SELECT_ALL_PARAMETERS)

#define OSSL_KEYMGMT_VALIDATE_FULL_CHECK 0
#define OSSL_KEYMGMT_VALIDATE_QUICK_CHECK 1

/* Basic key object creation */
#define OSSL_FUNC_KEYMGMT_NEW 1
OSSL_CORE_MAKE_FUNC(void *, keymgmt_new, (void *provctx))

/* Generation, a more complex constructor */
#define OSSL_FUNC_KEYMGMT_GEN_INIT 2
#define OSSL_FUNC_KEYMGMT_GEN_SET_TEMPLATE 3
#define OSSL_FUNC_KEYMGMT_GEN_SET_PARAMS 4
#define OSSL_FUNC_KEYMGMT_GEN_SETTABLE_PARAMS 5
#define OSSL_FUNC_KEYMGMT_GEN 6
#define OSSL_FUNC_KEYMGMT_GEN_CLEANUP 7
#define OSSL_FUNC_KEYMGMT_GEN_GET_PARAMS 15
#define OSSL_FUNC_KEYMGMT_GEN_GETTABLE_PARAMS 16

OSSL_CORE_MAKE_FUNC(void *, keymgmt_gen_init,
    (void *provctx, int selection, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, keymgmt_gen_set_template,
    (void *genctx, void *templ))
OSSL_CORE_MAKE_FUNC(int, keymgmt_gen_set_params,
    (void *genctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *,
    keymgmt_gen_settable_params,
    (void *genctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, keymgmt_gen_get_params,
    (void *genctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keymgmt_gen_gettable_params,
    (void *genctx, void *provctx))
OSSL_CORE_MAKE_FUNC(void *, keymgmt_gen,
    (void *genctx, OSSL_CALLBACK *cb, void *cbarg))
OSSL_CORE_MAKE_FUNC(void, keymgmt_gen_cleanup, (void *genctx))

/* Key loading by object reference */
#define OSSL_FUNC_KEYMGMT_LOAD 8
OSSL_CORE_MAKE_FUNC(void *, keymgmt_load,
    (const void *reference, size_t reference_sz))

/* Basic key object destruction */
#define OSSL_FUNC_KEYMGMT_FREE 10
OSSL_CORE_MAKE_FUNC(void, keymgmt_free, (void *keydata))

/* Key object information, with discovery */
#define OSSL_FUNC_KEYMGMT_GET_PARAMS 11
#define OSSL_FUNC_KEYMGMT_GETTABLE_PARAMS 12
OSSL_CORE_MAKE_FUNC(int, keymgmt_get_params,
    (void *keydata, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keymgmt_gettable_params,
    (void *provctx))

#define OSSL_FUNC_KEYMGMT_SET_PARAMS 13
#define OSSL_FUNC_KEYMGMT_SETTABLE_PARAMS 14
OSSL_CORE_MAKE_FUNC(int, keymgmt_set_params,
    (void *keydata, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keymgmt_settable_params,
    (void *provctx))

/* Key checks - discovery of supported operations */
#define OSSL_FUNC_KEYMGMT_QUERY_OPERATION_NAME 20
OSSL_CORE_MAKE_FUNC(const char *, keymgmt_query_operation_name,
    (int operation_id))

/* Key checks - key data content checks */
#define OSSL_FUNC_KEYMGMT_HAS 21
OSSL_CORE_MAKE_FUNC(int, keymgmt_has, (const void *keydata, int selection))

/* Key checks - validation */
#define OSSL_FUNC_KEYMGMT_VALIDATE 22
OSSL_CORE_MAKE_FUNC(int, keymgmt_validate, (const void *keydata, int selection, int checktype))

/* Key checks - matching */
#define OSSL_FUNC_KEYMGMT_MATCH 23
OSSL_CORE_MAKE_FUNC(int, keymgmt_match,
    (const void *keydata1, const void *keydata2,
        int selection))

/* Import and export functions, with discovery */
#define OSSL_FUNC_KEYMGMT_IMPORT 40
#define OSSL_FUNC_KEYMGMT_IMPORT_TYPES 41
#define OSSL_FUNC_KEYMGMT_EXPORT 42
#define OSSL_FUNC_KEYMGMT_EXPORT_TYPES 43
OSSL_CORE_MAKE_FUNC(int, keymgmt_import,
    (void *keydata, int selection, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keymgmt_import_types,
    (int selection))
OSSL_CORE_MAKE_FUNC(int, keymgmt_export,
    (void *keydata, int selection,
        OSSL_CALLBACK *param_cb, void *cbarg))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keymgmt_export_types,
    (int selection))

/* Dup function, constructor */
#define OSSL_FUNC_KEYMGMT_DUP 44
OSSL_CORE_MAKE_FUNC(void *, keymgmt_dup,
    (const void *keydata_from, int selection))

/* Extended import and export functions */
#define OSSL_FUNC_KEYMGMT_IMPORT_TYPES_EX 45
#define OSSL_FUNC_KEYMGMT_EXPORT_TYPES_EX 46
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keymgmt_import_types_ex,
    (void *provctx, int selection))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keymgmt_export_types_ex,
    (void *provctx, int selection))

/* Key Exchange */

#define OSSL_FUNC_KEYEXCH_NEWCTX 1
#define OSSL_FUNC_KEYEXCH_INIT 2
#define OSSL_FUNC_KEYEXCH_DERIVE 3
#define OSSL_FUNC_KEYEXCH_SET_PEER 4
#define OSSL_FUNC_KEYEXCH_FREECTX 5
#define OSSL_FUNC_KEYEXCH_DUPCTX 6
#define OSSL_FUNC_KEYEXCH_SET_CTX_PARAMS 7
#define OSSL_FUNC_KEYEXCH_SETTABLE_CTX_PARAMS 8
#define OSSL_FUNC_KEYEXCH_GET_CTX_PARAMS 9
#define OSSL_FUNC_KEYEXCH_GETTABLE_CTX_PARAMS 10
#define OSSL_FUNC_KEYEXCH_DERIVE_SKEY 11

OSSL_CORE_MAKE_FUNC(void *, keyexch_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(int, keyexch_init, (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, keyexch_derive, (void *ctx, unsigned char *secret, size_t *secretlen, size_t outlen))
OSSL_CORE_MAKE_FUNC(int, keyexch_set_peer, (void *ctx, void *provkey))
OSSL_CORE_MAKE_FUNC(void, keyexch_freectx, (void *ctx))
OSSL_CORE_MAKE_FUNC(void *, keyexch_dupctx, (void *ctx))
OSSL_CORE_MAKE_FUNC(int, keyexch_set_ctx_params, (void *ctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keyexch_settable_ctx_params,
    (void *ctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, keyexch_get_ctx_params, (void *ctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, keyexch_gettable_ctx_params,
    (void *ctx, void *provctx))
OSSL_CORE_MAKE_FUNC(void *, keyexch_derive_skey, (void *ctx, const char *key_type, void *provctx, OSSL_FUNC_skeymgmt_import_fn *import, size_t keylen, const OSSL_PARAM params[]))

/* Signature */

#define OSSL_FUNC_SIGNATURE_NEWCTX 1
#define OSSL_FUNC_SIGNATURE_SIGN_INIT 2
#define OSSL_FUNC_SIGNATURE_SIGN 3
#define OSSL_FUNC_SIGNATURE_VERIFY_INIT 4
#define OSSL_FUNC_SIGNATURE_VERIFY 5
#define OSSL_FUNC_SIGNATURE_VERIFY_RECOVER_INIT 6
#define OSSL_FUNC_SIGNATURE_VERIFY_RECOVER 7
#define OSSL_FUNC_SIGNATURE_DIGEST_SIGN_INIT 8
#define OSSL_FUNC_SIGNATURE_DIGEST_SIGN_UPDATE 9
#define OSSL_FUNC_SIGNATURE_DIGEST_SIGN_FINAL 10
#define OSSL_FUNC_SIGNATURE_DIGEST_SIGN 11
#define OSSL_FUNC_SIGNATURE_DIGEST_VERIFY_INIT 12
#define OSSL_FUNC_SIGNATURE_DIGEST_VERIFY_UPDATE 13
#define OSSL_FUNC_SIGNATURE_DIGEST_VERIFY_FINAL 14
#define OSSL_FUNC_SIGNATURE_DIGEST_VERIFY 15
#define OSSL_FUNC_SIGNATURE_FREECTX 16
#define OSSL_FUNC_SIGNATURE_DUPCTX 17
#define OSSL_FUNC_SIGNATURE_GET_CTX_PARAMS 18
#define OSSL_FUNC_SIGNATURE_GETTABLE_CTX_PARAMS 19
#define OSSL_FUNC_SIGNATURE_SET_CTX_PARAMS 20
#define OSSL_FUNC_SIGNATURE_SETTABLE_CTX_PARAMS 21
#define OSSL_FUNC_SIGNATURE_GET_CTX_MD_PARAMS 22
#define OSSL_FUNC_SIGNATURE_GETTABLE_CTX_MD_PARAMS 23
#define OSSL_FUNC_SIGNATURE_SET_CTX_MD_PARAMS 24
#define OSSL_FUNC_SIGNATURE_SETTABLE_CTX_MD_PARAMS 25
#define OSSL_FUNC_SIGNATURE_QUERY_KEY_TYPES 26
#define OSSL_FUNC_SIGNATURE_SIGN_MESSAGE_INIT 27
#define OSSL_FUNC_SIGNATURE_SIGN_MESSAGE_UPDATE 28
#define OSSL_FUNC_SIGNATURE_SIGN_MESSAGE_FINAL 29
#define OSSL_FUNC_SIGNATURE_VERIFY_MESSAGE_INIT 30
#define OSSL_FUNC_SIGNATURE_VERIFY_MESSAGE_UPDATE 31
#define OSSL_FUNC_SIGNATURE_VERIFY_MESSAGE_FINAL 32

OSSL_CORE_MAKE_FUNC(void *, signature_newctx, (void *provctx, const char *propq))
OSSL_CORE_MAKE_FUNC(int, signature_sign_init, (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, signature_sign, (void *ctx, unsigned char *sig, size_t *siglen, size_t sigsize, const unsigned char *tbs, size_t tbslen))
OSSL_CORE_MAKE_FUNC(int, signature_sign_message_init,
    (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, signature_sign_message_update,
    (void *ctx, const unsigned char *in, size_t inlen))
OSSL_CORE_MAKE_FUNC(int, signature_sign_message_final,
    (void *ctx, unsigned char *sig,
        size_t *siglen, size_t sigsize))
OSSL_CORE_MAKE_FUNC(int, signature_verify_init, (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, signature_verify, (void *ctx, const unsigned char *sig, size_t siglen, const unsigned char *tbs, size_t tbslen))
OSSL_CORE_MAKE_FUNC(int, signature_verify_message_init,
    (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, signature_verify_message_update,
    (void *ctx, const unsigned char *in, size_t inlen))
/*
 * signature_verify_final requires that the signature to be verified against
 * is specified via an OSSL_PARAM.
 */
OSSL_CORE_MAKE_FUNC(int, signature_verify_message_final, (void *ctx))
OSSL_CORE_MAKE_FUNC(int, signature_verify_recover_init,
    (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, signature_verify_recover,
    (void *ctx, unsigned char *rout, size_t *routlen,
        size_t routsize, const unsigned char *sig, size_t siglen))
OSSL_CORE_MAKE_FUNC(int, signature_digest_sign_init,
    (void *ctx, const char *mdname, void *provkey,
        const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, signature_digest_sign_update,
    (void *ctx, const unsigned char *data, size_t datalen))
OSSL_CORE_MAKE_FUNC(int, signature_digest_sign_final,
    (void *ctx, unsigned char *sig, size_t *siglen,
        size_t sigsize))
OSSL_CORE_MAKE_FUNC(int, signature_digest_sign,
    (void *ctx, unsigned char *sigret, size_t *siglen,
        size_t sigsize, const unsigned char *tbs, size_t tbslen))
OSSL_CORE_MAKE_FUNC(int, signature_digest_verify_init,
    (void *ctx, const char *mdname, void *provkey,
        const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, signature_digest_verify_update,
    (void *ctx, const unsigned char *data, size_t datalen))
OSSL_CORE_MAKE_FUNC(int, signature_digest_verify_final,
    (void *ctx, const unsigned char *sig, size_t siglen))
OSSL_CORE_MAKE_FUNC(int, signature_digest_verify,
    (void *ctx, const unsigned char *sig, size_t siglen,
        const unsigned char *tbs, size_t tbslen))
OSSL_CORE_MAKE_FUNC(void, signature_freectx, (void *ctx))
OSSL_CORE_MAKE_FUNC(void *, signature_dupctx, (void *ctx))
OSSL_CORE_MAKE_FUNC(int, signature_get_ctx_params,
    (void *ctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, signature_gettable_ctx_params,
    (void *ctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, signature_set_ctx_params,
    (void *ctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, signature_settable_ctx_params,
    (void *ctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, signature_get_ctx_md_params,
    (void *ctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, signature_gettable_ctx_md_params,
    (void *ctx))
OSSL_CORE_MAKE_FUNC(int, signature_set_ctx_md_params,
    (void *ctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, signature_settable_ctx_md_params,
    (void *ctx))
OSSL_CORE_MAKE_FUNC(const char **, signature_query_key_types, (void))

/* Asymmetric Ciphers */

#define OSSL_FUNC_ASYM_CIPHER_NEWCTX 1
#define OSSL_FUNC_ASYM_CIPHER_ENCRYPT_INIT 2
#define OSSL_FUNC_ASYM_CIPHER_ENCRYPT 3
#define OSSL_FUNC_ASYM_CIPHER_DECRYPT_INIT 4
#define OSSL_FUNC_ASYM_CIPHER_DECRYPT 5
#define OSSL_FUNC_ASYM_CIPHER_FREECTX 6
#define OSSL_FUNC_ASYM_CIPHER_DUPCTX 7
#define OSSL_FUNC_ASYM_CIPHER_GET_CTX_PARAMS 8
#define OSSL_FUNC_ASYM_CIPHER_GETTABLE_CTX_PARAMS 9
#define OSSL_FUNC_ASYM_CIPHER_SET_CTX_PARAMS 10
#define OSSL_FUNC_ASYM_CIPHER_SETTABLE_CTX_PARAMS 11

OSSL_CORE_MAKE_FUNC(void *, asym_cipher_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(int, asym_cipher_encrypt_init, (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, asym_cipher_encrypt, (void *ctx, unsigned char *out, size_t *outlen, size_t outsize, const unsigned char *in, size_t inlen))
OSSL_CORE_MAKE_FUNC(int, asym_cipher_decrypt_init, (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, asym_cipher_decrypt, (void *ctx, unsigned char *out, size_t *outlen, size_t outsize, const unsigned char *in, size_t inlen))
OSSL_CORE_MAKE_FUNC(void, asym_cipher_freectx, (void *ctx))
OSSL_CORE_MAKE_FUNC(void *, asym_cipher_dupctx, (void *ctx))
OSSL_CORE_MAKE_FUNC(int, asym_cipher_get_ctx_params,
    (void *ctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, asym_cipher_gettable_ctx_params,
    (void *ctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, asym_cipher_set_ctx_params,
    (void *ctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, asym_cipher_settable_ctx_params,
    (void *ctx, void *provctx))

/* Asymmetric Key encapsulation */
#define OSSL_FUNC_KEM_NEWCTX 1
#define OSSL_FUNC_KEM_ENCAPSULATE_INIT 2
#define OSSL_FUNC_KEM_ENCAPSULATE 3
#define OSSL_FUNC_KEM_DECAPSULATE_INIT 4
#define OSSL_FUNC_KEM_DECAPSULATE 5
#define OSSL_FUNC_KEM_FREECTX 6
#define OSSL_FUNC_KEM_DUPCTX 7
#define OSSL_FUNC_KEM_GET_CTX_PARAMS 8
#define OSSL_FUNC_KEM_GETTABLE_CTX_PARAMS 9
#define OSSL_FUNC_KEM_SET_CTX_PARAMS 10
#define OSSL_FUNC_KEM_SETTABLE_CTX_PARAMS 11
#define OSSL_FUNC_KEM_AUTH_ENCAPSULATE_INIT 12
#define OSSL_FUNC_KEM_AUTH_DECAPSULATE_INIT 13

OSSL_CORE_MAKE_FUNC(void *, kem_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(int, kem_encapsulate_init, (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, kem_auth_encapsulate_init, (void *ctx, void *provkey, void *authprivkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, kem_encapsulate, (void *ctx, unsigned char *out, size_t *outlen, unsigned char *secret, size_t *secretlen))
OSSL_CORE_MAKE_FUNC(int, kem_decapsulate_init, (void *ctx, void *provkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, kem_auth_decapsulate_init, (void *ctx, void *provkey, void *authpubkey, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, kem_decapsulate, (void *ctx, unsigned char *out, size_t *outlen, const unsigned char *in, size_t inlen))
OSSL_CORE_MAKE_FUNC(void, kem_freectx, (void *ctx))
OSSL_CORE_MAKE_FUNC(void *, kem_dupctx, (void *ctx))
OSSL_CORE_MAKE_FUNC(int, kem_get_ctx_params, (void *ctx, OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, kem_gettable_ctx_params,
    (void *ctx, void *provctx))
OSSL_CORE_MAKE_FUNC(int, kem_set_ctx_params,
    (void *ctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, kem_settable_ctx_params,
    (void *ctx, void *provctx))

/* Encoders and decoders */
#define OSSL_FUNC_ENCODER_NEWCTX 1
#define OSSL_FUNC_ENCODER_FREECTX 2
#define OSSL_FUNC_ENCODER_GET_PARAMS 3
#define OSSL_FUNC_ENCODER_GETTABLE_PARAMS 4
#define OSSL_FUNC_ENCODER_SET_CTX_PARAMS 5
#define OSSL_FUNC_ENCODER_SETTABLE_CTX_PARAMS 6
#define OSSL_FUNC_ENCODER_DOES_SELECTION 10
#define OSSL_FUNC_ENCODER_ENCODE 11
#define OSSL_FUNC_ENCODER_IMPORT_OBJECT 20
#define OSSL_FUNC_ENCODER_FREE_OBJECT 21
OSSL_CORE_MAKE_FUNC(void *, encoder_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(void, encoder_freectx, (void *ctx))
OSSL_CORE_MAKE_FUNC(int, encoder_get_params, (OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, encoder_gettable_params,
    (void *provctx))
OSSL_CORE_MAKE_FUNC(int, encoder_set_ctx_params,
    (void *ctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, encoder_settable_ctx_params,
    (void *provctx))

OSSL_CORE_MAKE_FUNC(int, encoder_does_selection,
    (void *provctx, int selection))
OSSL_CORE_MAKE_FUNC(int, encoder_encode,
    (void *ctx, OSSL_CORE_BIO *out,
        const void *obj_raw, const OSSL_PARAM obj_abstract[],
        int selection,
        OSSL_PASSPHRASE_CALLBACK *cb, void *cbarg))

OSSL_CORE_MAKE_FUNC(void *, encoder_import_object,
    (void *ctx, int selection, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(void, encoder_free_object, (void *obj))

#define OSSL_FUNC_DECODER_NEWCTX 1
#define OSSL_FUNC_DECODER_FREECTX 2
#define OSSL_FUNC_DECODER_GET_PARAMS 3
#define OSSL_FUNC_DECODER_GETTABLE_PARAMS 4
#define OSSL_FUNC_DECODER_SET_CTX_PARAMS 5
#define OSSL_FUNC_DECODER_SETTABLE_CTX_PARAMS 6
#define OSSL_FUNC_DECODER_DOES_SELECTION 10
#define OSSL_FUNC_DECODER_DECODE 11
#define OSSL_FUNC_DECODER_EXPORT_OBJECT 20
OSSL_CORE_MAKE_FUNC(void *, decoder_newctx, (void *provctx))
OSSL_CORE_MAKE_FUNC(void, decoder_freectx, (void *ctx))
OSSL_CORE_MAKE_FUNC(int, decoder_get_params, (OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, decoder_gettable_params,
    (void *provctx))
OSSL_CORE_MAKE_FUNC(int, decoder_set_ctx_params,
    (void *ctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, decoder_settable_ctx_params,
    (void *provctx))

OSSL_CORE_MAKE_FUNC(int, decoder_does_selection,
    (void *provctx, int selection))
OSSL_CORE_MAKE_FUNC(int, decoder_decode,
    (void *ctx, OSSL_CORE_BIO *in, int selection,
        OSSL_CALLBACK *data_cb, void *data_cbarg,
        OSSL_PASSPHRASE_CALLBACK *pw_cb, void *pw_cbarg))
OSSL_CORE_MAKE_FUNC(int, decoder_export_object,
    (void *ctx, const void *objref, size_t objref_sz,
        OSSL_CALLBACK *export_cb, void *export_cbarg))

/*-
 * Store
 *
 * Objects are scanned by using the 'open', 'load', 'eof' and 'close'
 * functions, which implement an OSSL_STORE loader.
 *
 * store_load() works in a way that's very similar to the decoders, in
 * that they pass an abstract object through a callback, either as a DER
 * octet string or as an object reference, which libcrypto will have to
 * deal with.
 */

#define OSSL_FUNC_STORE_OPEN 1
#define OSSL_FUNC_STORE_ATTACH 2
#define OSSL_FUNC_STORE_SETTABLE_CTX_PARAMS 3
#define OSSL_FUNC_STORE_SET_CTX_PARAMS 4
#define OSSL_FUNC_STORE_LOAD 5
#define OSSL_FUNC_STORE_EOF 6
#define OSSL_FUNC_STORE_CLOSE 7
#define OSSL_FUNC_STORE_EXPORT_OBJECT 8
#define OSSL_FUNC_STORE_DELETE 9
#define OSSL_FUNC_STORE_OPEN_EX 10
OSSL_CORE_MAKE_FUNC(void *, store_open, (void *provctx, const char *uri))
OSSL_CORE_MAKE_FUNC(void *, store_attach, (void *provctx, OSSL_CORE_BIO *in))
OSSL_CORE_MAKE_FUNC(const OSSL_PARAM *, store_settable_ctx_params,
    (void *provctx))
OSSL_CORE_MAKE_FUNC(int, store_set_ctx_params,
    (void *loaderctx, const OSSL_PARAM params[]))
OSSL_CORE_MAKE_FUNC(int, store_load,
    (void *loaderctx,
        OSSL_CALLBACK *object_cb, void *object_cbarg,
        OSSL_PASSPHRASE_CALLBACK *pw_cb, void *pw_cbarg))
OSSL_CORE_MAKE_FUNC(int, store_eof, (void *loaderctx))
OSSL_CORE_MAKE_FUNC(int, store_close, (void *loaderctx))
OSSL_CORE_MAKE_FUNC(int, store_export_object,
    (void *loaderctx, const void *objref, size_t objref_sz,
        OSSL_CALLBACK *export_cb, void *export_cbarg))
OSSL_CORE_MAKE_FUNC(int, store_delete,
    (void *provctx, const char *uri, const OSSL_PARAM params[],
        OSSL_PASSPHRASE_CALLBACK *pw_cb, void *pw_cbarg))
OSSL_CORE_MAKE_FUNC(void *, store_open_ex,
    (void *provctx, const char *uri, const OSSL_PARAM params[],
        OSSL_PASSPHRASE_CALLBACK *pw_cb, void *pw_cbarg))

#ifdef __cplusplus
}
#endif

#endif
