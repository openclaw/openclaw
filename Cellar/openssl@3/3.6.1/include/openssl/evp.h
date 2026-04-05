/*
 * Copyright 1995-2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_EVP_H
#define OPENSSL_EVP_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_ENVELOPE_H
#endif

#include <stdarg.h>

#ifndef OPENSSL_NO_STDIO
#include <stdio.h>
#endif

#include <openssl/opensslconf.h>
#include <openssl/types.h>
#include <openssl/core.h>
#include <openssl/core_dispatch.h>
#include <openssl/symhacks.h>
#include <openssl/bio.h>
#include <openssl/evperr.h>
#include <openssl/params.h>

#define EVP_MAX_MD_SIZE 64 /* longest known is SHA512 */
#define EVP_MAX_KEY_LENGTH 64
#define EVP_MAX_IV_LENGTH 16
#define EVP_MAX_BLOCK_LENGTH 32
#define EVP_MAX_AEAD_TAG_LENGTH 16

/* Maximum pipes in cipher pipelining */
#define EVP_MAX_PIPES 32

#define PKCS5_SALT_LEN 8
/* Default PKCS#5 iteration count */
#define PKCS5_DEFAULT_ITER 2048

#include <openssl/objects.h>

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define EVP_PK_RSA 0x0001
#define EVP_PK_DSA 0x0002
#define EVP_PK_DH 0x0004
#define EVP_PK_EC 0x0008
#define EVP_PKT_SIGN 0x0010
#define EVP_PKT_ENC 0x0020
#define EVP_PKT_EXCH 0x0040
#define EVP_PKS_RSA 0x0100
#define EVP_PKS_DSA 0x0200
#define EVP_PKS_EC 0x0400
#endif

#define EVP_PKEY_NONE NID_undef
#define EVP_PKEY_RSA NID_rsaEncryption
#define EVP_PKEY_RSA2 NID_rsa
#define EVP_PKEY_RSA_PSS NID_rsassaPss
#define EVP_PKEY_DSA NID_dsa
#define EVP_PKEY_DSA1 NID_dsa_2
#define EVP_PKEY_DSA2 NID_dsaWithSHA
#define EVP_PKEY_DSA3 NID_dsaWithSHA1
#define EVP_PKEY_DSA4 NID_dsaWithSHA1_2
#define EVP_PKEY_DH NID_dhKeyAgreement
#define EVP_PKEY_DHX NID_dhpublicnumber
#define EVP_PKEY_EC NID_X9_62_id_ecPublicKey
#define EVP_PKEY_SM2 NID_sm2
#define EVP_PKEY_HMAC NID_hmac
#define EVP_PKEY_CMAC NID_cmac
#define EVP_PKEY_SCRYPT NID_id_scrypt
#define EVP_PKEY_TLS1_PRF NID_tls1_prf
#define EVP_PKEY_HKDF NID_hkdf
#define EVP_PKEY_POLY1305 NID_poly1305
#define EVP_PKEY_SIPHASH NID_siphash
#define EVP_PKEY_X25519 NID_X25519
#define EVP_PKEY_ED25519 NID_ED25519
#define EVP_PKEY_X448 NID_X448
#define EVP_PKEY_ED448 NID_ED448
#define EVP_PKEY_ML_DSA_44 NID_ML_DSA_44
#define EVP_PKEY_ML_DSA_65 NID_ML_DSA_65
#define EVP_PKEY_ML_DSA_87 NID_ML_DSA_87
#define EVP_PKEY_SLH_DSA_SHA2_128S NID_SLH_DSA_SHA2_128s
#define EVP_PKEY_SLH_DSA_SHA2_128F NID_SLH_DSA_SHA2_128f
#define EVP_PKEY_SLH_DSA_SHA2_192S NID_SLH_DSA_SHA2_192s
#define EVP_PKEY_SLH_DSA_SHA2_192F NID_SLH_DSA_SHA2_192f
#define EVP_PKEY_SLH_DSA_SHA2_256S NID_SLH_DSA_SHA2_256s
#define EVP_PKEY_SLH_DSA_SHA2_256F NID_SLH_DSA_SHA2_256f
#define EVP_PKEY_SLH_DSA_SHAKE_128S NID_SLH_DSA_SHAKE_128s
#define EVP_PKEY_SLH_DSA_SHAKE_128F NID_SLH_DSA_SHAKE_128f
#define EVP_PKEY_SLH_DSA_SHAKE_192S NID_SLH_DSA_SHAKE_192s
#define EVP_PKEY_SLH_DSA_SHAKE_192F NID_SLH_DSA_SHAKE_192f
#define EVP_PKEY_SLH_DSA_SHAKE_256S NID_SLH_DSA_SHAKE_256s
#define EVP_PKEY_SLH_DSA_SHAKE_256F NID_SLH_DSA_SHAKE_256f

/* Special indicator that the object is uniquely provider side */
#define EVP_PKEY_KEYMGMT -1

/* Easy to use macros for EVP_PKEY related selections */
#define EVP_PKEY_KEY_PARAMETERS \
    (OSSL_KEYMGMT_SELECT_ALL_PARAMETERS)
#define EVP_PKEY_PRIVATE_KEY \
    (EVP_PKEY_KEY_PARAMETERS | OSSL_KEYMGMT_SELECT_PRIVATE_KEY)
#define EVP_PKEY_PUBLIC_KEY \
    (EVP_PKEY_KEY_PARAMETERS | OSSL_KEYMGMT_SELECT_PUBLIC_KEY)
#define EVP_PKEY_KEYPAIR \
    (EVP_PKEY_PUBLIC_KEY | OSSL_KEYMGMT_SELECT_PRIVATE_KEY)

#ifdef __cplusplus
extern "C" {
#endif

int EVP_set_default_properties(OSSL_LIB_CTX *libctx, const char *propq);
char *EVP_get1_default_properties(OSSL_LIB_CTX *libctx);
int EVP_default_properties_is_fips_enabled(OSSL_LIB_CTX *libctx);
int EVP_default_properties_enable_fips(OSSL_LIB_CTX *libctx, int enable);

#define EVP_PKEY_MO_SIGN 0x0001
#define EVP_PKEY_MO_VERIFY 0x0002
#define EVP_PKEY_MO_ENCRYPT 0x0004
#define EVP_PKEY_MO_DECRYPT 0x0008

#ifndef EVP_MD
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 EVP_MD *EVP_MD_meth_new(int md_type, int pkey_type);
OSSL_DEPRECATEDIN_3_0 EVP_MD *EVP_MD_meth_dup(const EVP_MD *md);
OSSL_DEPRECATEDIN_3_0 void EVP_MD_meth_free(EVP_MD *md);
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_input_blocksize(EVP_MD *md, int blocksize);
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_result_size(EVP_MD *md, int resultsize);
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_app_datasize(EVP_MD *md, int datasize);
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_flags(EVP_MD *md, unsigned long flags);
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_init(EVP_MD *md, int (*init)(EVP_MD_CTX *ctx));
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_update(EVP_MD *md, int (*update)(EVP_MD_CTX *ctx, const void *data, size_t count));
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_final(EVP_MD *md, int (*final)(EVP_MD_CTX *ctx, unsigned char *md));
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_copy(EVP_MD *md, int (*copy)(EVP_MD_CTX *to, const EVP_MD_CTX *from));
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_cleanup(EVP_MD *md, int (*cleanup)(EVP_MD_CTX *ctx));
OSSL_DEPRECATEDIN_3_0
int EVP_MD_meth_set_ctrl(EVP_MD *md, int (*ctrl)(EVP_MD_CTX *ctx, int cmd, int p1, void *p2));
OSSL_DEPRECATEDIN_3_0 int EVP_MD_meth_get_input_blocksize(const EVP_MD *md);
OSSL_DEPRECATEDIN_3_0 int EVP_MD_meth_get_result_size(const EVP_MD *md);
OSSL_DEPRECATEDIN_3_0 int EVP_MD_meth_get_app_datasize(const EVP_MD *md);
OSSL_DEPRECATEDIN_3_0 unsigned long EVP_MD_meth_get_flags(const EVP_MD *md);
OSSL_DEPRECATEDIN_3_0
int (*EVP_MD_meth_get_init(const EVP_MD *md))(EVP_MD_CTX *ctx);
OSSL_DEPRECATEDIN_3_0
int (*EVP_MD_meth_get_update(const EVP_MD *md))(EVP_MD_CTX *ctx,
    const void *data, size_t count);
OSSL_DEPRECATEDIN_3_0
int (*EVP_MD_meth_get_final(const EVP_MD *md))(EVP_MD_CTX *ctx,
    unsigned char *md);
OSSL_DEPRECATEDIN_3_0
int (*EVP_MD_meth_get_copy(const EVP_MD *md))(EVP_MD_CTX *to,
    const EVP_MD_CTX *from);
OSSL_DEPRECATEDIN_3_0
int (*EVP_MD_meth_get_cleanup(const EVP_MD *md))(EVP_MD_CTX *ctx);
OSSL_DEPRECATEDIN_3_0
int (*EVP_MD_meth_get_ctrl(const EVP_MD *md))(EVP_MD_CTX *ctx, int cmd,
    int p1, void *p2);
#endif
/* digest can only handle a single block */
#define EVP_MD_FLAG_ONESHOT 0x0001

/* digest is extensible-output function, XOF */
#define EVP_MD_FLAG_XOF 0x0002

/* DigestAlgorithmIdentifier flags... */

#define EVP_MD_FLAG_DIGALGID_MASK 0x0018

/* NULL or absent parameter accepted. Use NULL */

#define EVP_MD_FLAG_DIGALGID_NULL 0x0000

/* NULL or absent parameter accepted. Use NULL for PKCS#1 otherwise absent */

#define EVP_MD_FLAG_DIGALGID_ABSENT 0x0008

/* Custom handling via ctrl */

#define EVP_MD_FLAG_DIGALGID_CUSTOM 0x0018

/* Note if suitable for use in FIPS mode */
#define EVP_MD_FLAG_FIPS 0x0400

/* Digest ctrls */

#define EVP_MD_CTRL_DIGALGID 0x1
#define EVP_MD_CTRL_MICALG 0x2
#define EVP_MD_CTRL_XOF_LEN 0x3
#define EVP_MD_CTRL_TLSTREE 0x4

/* Minimum Algorithm specific ctrl value */

#define EVP_MD_CTRL_ALG_CTRL 0x1000

#endif /* !EVP_MD */

/* values for EVP_MD_CTX flags */

#define EVP_MD_CTX_FLAG_ONESHOT 0x0001 /* digest update will be \
                                        * called once only */
#define EVP_MD_CTX_FLAG_CLEANED 0x0002 /* context has already been \
                                        * cleaned */
#define EVP_MD_CTX_FLAG_REUSE 0x0004 /* Don't free up ctx->md_data \
                                      * in EVP_MD_CTX_reset */
/*
 * FIPS and pad options are ignored in 1.0.0, definitions are here so we
 * don't accidentally reuse the values for other purposes.
 */

/* This flag has no effect from openssl-3.0 onwards */
#define EVP_MD_CTX_FLAG_NON_FIPS_ALLOW 0x0008

/*
 * The following PAD options are also currently ignored in 1.0.0, digest
 * parameters are handled through EVP_DigestSign*() and EVP_DigestVerify*()
 * instead.
 */
#define EVP_MD_CTX_FLAG_PAD_MASK 0xF0 /* RSA mode to use */
#define EVP_MD_CTX_FLAG_PAD_PKCS1 0x00 /* PKCS#1 v1.5 mode */
#define EVP_MD_CTX_FLAG_PAD_X931 0x10 /* X9.31 mode */
#define EVP_MD_CTX_FLAG_PAD_PSS 0x20 /* PSS mode */

#define EVP_MD_CTX_FLAG_NO_INIT 0x0100 /* Don't initialize md_data */
/*
 * Some functions such as EVP_DigestSign only finalise copies of internal
 * contexts so additional data can be included after the finalisation call.
 * This is inefficient if this functionality is not required: it is disabled
 * if the following flag is set.
 */
#define EVP_MD_CTX_FLAG_FINALISE 0x0200
/* NOTE: 0x0400 and 0x0800 are reserved for internal usage */

#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
EVP_CIPHER *EVP_CIPHER_meth_new(int cipher_type, int block_size, int key_len);
OSSL_DEPRECATEDIN_3_0
EVP_CIPHER *EVP_CIPHER_meth_dup(const EVP_CIPHER *cipher);
OSSL_DEPRECATEDIN_3_0
void EVP_CIPHER_meth_free(EVP_CIPHER *cipher);
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_iv_length(EVP_CIPHER *cipher, int iv_len);
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_flags(EVP_CIPHER *cipher, unsigned long flags);
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_impl_ctx_size(EVP_CIPHER *cipher, int ctx_size);
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_init(EVP_CIPHER *cipher,
    int (*init)(EVP_CIPHER_CTX *ctx,
        const unsigned char *key,
        const unsigned char *iv,
        int enc));
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_do_cipher(EVP_CIPHER *cipher,
    int (*do_cipher)(EVP_CIPHER_CTX *ctx,
        unsigned char *out,
        const unsigned char *in,
        size_t inl));
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_cleanup(EVP_CIPHER *cipher,
    int (*cleanup)(EVP_CIPHER_CTX *));
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_set_asn1_params(EVP_CIPHER *cipher,
    int (*set_asn1_parameters)(EVP_CIPHER_CTX *,
        ASN1_TYPE *));
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_get_asn1_params(EVP_CIPHER *cipher,
    int (*get_asn1_parameters)(EVP_CIPHER_CTX *,
        ASN1_TYPE *));
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_meth_set_ctrl(EVP_CIPHER *cipher,
    int (*ctrl)(EVP_CIPHER_CTX *, int type,
        int arg, void *ptr));
OSSL_DEPRECATEDIN_3_0 int (*EVP_CIPHER_meth_get_init(const EVP_CIPHER *cipher))(EVP_CIPHER_CTX *ctx,
    const unsigned char *key,
    const unsigned char *iv,
    int enc);
OSSL_DEPRECATEDIN_3_0 int (*EVP_CIPHER_meth_get_do_cipher(const EVP_CIPHER *cipher))(EVP_CIPHER_CTX *ctx,
    unsigned char *out,
    const unsigned char *in,
    size_t inl);
OSSL_DEPRECATEDIN_3_0 int (*EVP_CIPHER_meth_get_cleanup(const EVP_CIPHER *cipher))(EVP_CIPHER_CTX *);
OSSL_DEPRECATEDIN_3_0 int (*EVP_CIPHER_meth_get_set_asn1_params(const EVP_CIPHER *cipher))(EVP_CIPHER_CTX *,
    ASN1_TYPE *);
OSSL_DEPRECATEDIN_3_0 int (*EVP_CIPHER_meth_get_get_asn1_params(const EVP_CIPHER *cipher))(EVP_CIPHER_CTX *,
    ASN1_TYPE *);
OSSL_DEPRECATEDIN_3_0 int (*EVP_CIPHER_meth_get_ctrl(const EVP_CIPHER *cipher))(EVP_CIPHER_CTX *, int type,
    int arg, void *ptr);
#endif

/* Values for cipher flags */

/* Modes for ciphers */

#define EVP_CIPH_STREAM_CIPHER 0x0
#define EVP_CIPH_ECB_MODE 0x1
#define EVP_CIPH_CBC_MODE 0x2
#define EVP_CIPH_CFB_MODE 0x3
#define EVP_CIPH_OFB_MODE 0x4
#define EVP_CIPH_CTR_MODE 0x5
#define EVP_CIPH_GCM_MODE 0x6
#define EVP_CIPH_CCM_MODE 0x7
#define EVP_CIPH_XTS_MODE 0x10001
#define EVP_CIPH_WRAP_MODE 0x10002
#define EVP_CIPH_OCB_MODE 0x10003
#define EVP_CIPH_SIV_MODE 0x10004
#define EVP_CIPH_GCM_SIV_MODE 0x10005
#define EVP_CIPH_MODE 0xF0007
/* Set if variable length cipher */
#define EVP_CIPH_VARIABLE_LENGTH 0x8
/* Set if the iv handling should be done by the cipher itself */
#define EVP_CIPH_CUSTOM_IV 0x10
/* Set if the cipher's init() function should be called if key is NULL */
#define EVP_CIPH_ALWAYS_CALL_INIT 0x20
/* Call ctrl() to init cipher parameters */
#define EVP_CIPH_CTRL_INIT 0x40
/* Don't use standard key length function */
#define EVP_CIPH_CUSTOM_KEY_LENGTH 0x80
/* Don't use standard block padding */
#define EVP_CIPH_NO_PADDING 0x100
/* cipher handles random key generation */
#define EVP_CIPH_RAND_KEY 0x200
/* cipher has its own additional copying logic */
#define EVP_CIPH_CUSTOM_COPY 0x400
/* Don't use standard iv length function */
#define EVP_CIPH_CUSTOM_IV_LENGTH 0x800
/* Legacy and no longer relevant: Allow use default ASN1 get/set iv */
#define EVP_CIPH_FLAG_DEFAULT_ASN1 0
/* Free:                                         0x1000 */
/* Buffer length in bits not bytes: CFB1 mode only */
#define EVP_CIPH_FLAG_LENGTH_BITS 0x2000
/* Deprecated FIPS flag: was 0x4000 */
#define EVP_CIPH_FLAG_FIPS 0
/* Deprecated FIPS flag: was 0x8000 */
#define EVP_CIPH_FLAG_NON_FIPS_ALLOW 0

/*
 * Cipher handles any and all padding logic as well as finalisation.
 */
#define EVP_CIPH_FLAG_CTS 0x4000
#define EVP_CIPH_FLAG_CUSTOM_CIPHER 0x100000
#define EVP_CIPH_FLAG_AEAD_CIPHER 0x200000
#define EVP_CIPH_FLAG_TLS1_1_MULTIBLOCK 0x400000
/* Cipher can handle pipeline operations */
#define EVP_CIPH_FLAG_PIPELINE 0X800000
/* For provider implementations that handle  ASN1 get/set param themselves */
#define EVP_CIPH_FLAG_CUSTOM_ASN1 0x1000000
/* For ciphers generating unprotected CMS attributes */
#define EVP_CIPH_FLAG_CIPHER_WITH_MAC 0x2000000
/* For supplementary wrap cipher support */
#define EVP_CIPH_FLAG_GET_WRAP_CIPHER 0x4000000
#define EVP_CIPH_FLAG_INVERSE_CIPHER 0x8000000
#define EVP_CIPH_FLAG_ENC_THEN_MAC 0x10000000

/*
 * Cipher context flag to indicate we can handle wrap mode: if allowed in
 * older applications it could overflow buffers.
 */

#define EVP_CIPHER_CTX_FLAG_WRAP_ALLOW 0x1

/* ctrl() values */

#define EVP_CTRL_INIT 0x0
#define EVP_CTRL_SET_KEY_LENGTH 0x1
#define EVP_CTRL_GET_RC2_KEY_BITS 0x2
#define EVP_CTRL_SET_RC2_KEY_BITS 0x3
#define EVP_CTRL_GET_RC5_ROUNDS 0x4
#define EVP_CTRL_SET_RC5_ROUNDS 0x5
#define EVP_CTRL_RAND_KEY 0x6
#define EVP_CTRL_PBE_PRF_NID 0x7
#define EVP_CTRL_COPY 0x8
#define EVP_CTRL_AEAD_SET_IVLEN 0x9
#define EVP_CTRL_AEAD_GET_TAG 0x10
#define EVP_CTRL_AEAD_SET_TAG 0x11
#define EVP_CTRL_AEAD_SET_IV_FIXED 0x12
#define EVP_CTRL_GCM_SET_IVLEN EVP_CTRL_AEAD_SET_IVLEN
#define EVP_CTRL_GCM_GET_TAG EVP_CTRL_AEAD_GET_TAG
#define EVP_CTRL_GCM_SET_TAG EVP_CTRL_AEAD_SET_TAG
#define EVP_CTRL_GCM_SET_IV_FIXED EVP_CTRL_AEAD_SET_IV_FIXED
#define EVP_CTRL_GCM_IV_GEN 0x13
#define EVP_CTRL_CCM_SET_IVLEN EVP_CTRL_AEAD_SET_IVLEN
#define EVP_CTRL_CCM_GET_TAG EVP_CTRL_AEAD_GET_TAG
#define EVP_CTRL_CCM_SET_TAG EVP_CTRL_AEAD_SET_TAG
#define EVP_CTRL_CCM_SET_IV_FIXED EVP_CTRL_AEAD_SET_IV_FIXED
#define EVP_CTRL_CCM_SET_L 0x14
#define EVP_CTRL_CCM_SET_MSGLEN 0x15
/*
 * AEAD cipher deduces payload length and returns number of bytes required to
 * store MAC and eventual padding. Subsequent call to EVP_Cipher even
 * appends/verifies MAC.
 */
#define EVP_CTRL_AEAD_TLS1_AAD 0x16
/* Used by composite AEAD ciphers, no-op in GCM, CCM... */
#define EVP_CTRL_AEAD_SET_MAC_KEY 0x17
/* Set the GCM invocation field, decrypt only */
#define EVP_CTRL_GCM_SET_IV_INV 0x18

#define EVP_CTRL_TLS1_1_MULTIBLOCK_AAD 0x19
#define EVP_CTRL_TLS1_1_MULTIBLOCK_ENCRYPT 0x1a
#define EVP_CTRL_TLS1_1_MULTIBLOCK_DECRYPT 0x1b
#define EVP_CTRL_TLS1_1_MULTIBLOCK_MAX_BUFSIZE 0x1c

#define EVP_CTRL_SSL3_MASTER_SECRET 0x1d

/* EVP_CTRL_SET_SBOX takes the char * specifying S-boxes */
#define EVP_CTRL_SET_SBOX 0x1e
/*
 * EVP_CTRL_SBOX_USED takes a 'size_t' and 'char *', pointing at a
 * pre-allocated buffer with specified size
 */
#define EVP_CTRL_SBOX_USED 0x1f
/* EVP_CTRL_KEY_MESH takes 'size_t' number of bytes to mesh the key after,
 * 0 switches meshing off
 */
#define EVP_CTRL_KEY_MESH 0x20
/* EVP_CTRL_BLOCK_PADDING_MODE takes the padding mode */
#define EVP_CTRL_BLOCK_PADDING_MODE 0x21

/* Set the output buffers to use for a pipelined operation */
#define EVP_CTRL_SET_PIPELINE_OUTPUT_BUFS 0x22
/* Set the input buffers to use for a pipelined operation */
#define EVP_CTRL_SET_PIPELINE_INPUT_BUFS 0x23
/* Set the input buffer lengths to use for a pipelined operation */
#define EVP_CTRL_SET_PIPELINE_INPUT_LENS 0x24
/* Get the IV length used by the cipher */
#define EVP_CTRL_GET_IVLEN 0x25
/* 0x26 is unused */
/* Tell the cipher it's doing a speed test (SIV disallows multiple ops) */
#define EVP_CTRL_SET_SPEED 0x27
/* Get the unprotectedAttrs from cipher ctx */
#define EVP_CTRL_PROCESS_UNPROTECTED 0x28
/* Get the supplementary wrap cipher */
#define EVP_CTRL_GET_WRAP_CIPHER 0x29
/* TLSTREE key diversification */
#define EVP_CTRL_TLSTREE 0x2A

/* Padding modes */
#define EVP_PADDING_PKCS7 1
#define EVP_PADDING_ISO7816_4 2
#define EVP_PADDING_ANSI923 3
#define EVP_PADDING_ISO10126 4
#define EVP_PADDING_ZERO 5

/* RFC 5246 defines additional data to be 13 bytes in length */
#define EVP_AEAD_TLS1_AAD_LEN 13

typedef struct {
    unsigned char *out;
    const unsigned char *inp;
    size_t len;
    unsigned int interleave;
} EVP_CTRL_TLS1_1_MULTIBLOCK_PARAM;

/* GCM TLS constants */
/* Length of fixed part of IV derived from PRF */
#define EVP_GCM_TLS_FIXED_IV_LEN 4
/* Length of explicit part of IV part of TLS records */
#define EVP_GCM_TLS_EXPLICIT_IV_LEN 8
/* Length of tag for TLS */
#define EVP_GCM_TLS_TAG_LEN 16

/* CCM TLS constants */
/* Length of fixed part of IV derived from PRF */
#define EVP_CCM_TLS_FIXED_IV_LEN 4
/* Length of explicit part of IV part of TLS records */
#define EVP_CCM_TLS_EXPLICIT_IV_LEN 8
/* Total length of CCM IV length for TLS */
#define EVP_CCM_TLS_IV_LEN 12
/* Length of tag for TLS */
#define EVP_CCM_TLS_TAG_LEN 16
/* Length of CCM8 tag for TLS */
#define EVP_CCM8_TLS_TAG_LEN 8

/* Length of tag for TLS */
#define EVP_CHACHAPOLY_TLS_TAG_LEN 16

typedef struct evp_cipher_info_st {
    const EVP_CIPHER *cipher;
    unsigned char iv[EVP_MAX_IV_LENGTH];
} EVP_CIPHER_INFO;

/* Password based encryption function */
typedef int(EVP_PBE_KEYGEN)(EVP_CIPHER_CTX *ctx, const char *pass,
    int passlen, ASN1_TYPE *param,
    const EVP_CIPHER *cipher, const EVP_MD *md,
    int en_de);

typedef int(EVP_PBE_KEYGEN_EX)(EVP_CIPHER_CTX *ctx, const char *pass,
    int passlen, ASN1_TYPE *param,
    const EVP_CIPHER *cipher, const EVP_MD *md,
    int en_de, OSSL_LIB_CTX *libctx, const char *propq);

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define EVP_PKEY_assign_RSA(pkey, rsa) EVP_PKEY_assign((pkey), EVP_PKEY_RSA, \
    (rsa))
#endif

#ifndef OPENSSL_NO_DEPRECATED_3_6
#ifndef OPENSSL_NO_DSA
#define EVP_PKEY_assign_DSA(pkey, dsa) EVP_PKEY_assign((pkey), EVP_PKEY_DSA, \
    (dsa))
#endif
#endif

#if !defined(OPENSSL_NO_DH) && !defined(OPENSSL_NO_DEPRECATED_3_0)
#define EVP_PKEY_assign_DH(pkey, dh) EVP_PKEY_assign((pkey), EVP_PKEY_DH, (dh))
#endif

#ifndef OPENSSL_NO_DEPRECATED_3_0
#ifndef OPENSSL_NO_EC
#define EVP_PKEY_assign_EC_KEY(pkey, eckey) EVP_PKEY_assign((pkey), \
    EVP_PKEY_EC,                                                    \
    (eckey))
#endif
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_6
#ifndef OPENSSL_NO_SIPHASH
#define EVP_PKEY_assign_SIPHASH(pkey, shkey) EVP_PKEY_assign((pkey), \
    EVP_PKEY_SIPHASH,                                                \
    (shkey))
#endif

#ifndef OPENSSL_NO_POLY1305
#define EVP_PKEY_assign_POLY1305(pkey, polykey) EVP_PKEY_assign((pkey), \
    EVP_PKEY_POLY1305,                                                  \
    (polykey))
#endif
#endif

/* Add some extra combinations */
#define EVP_get_digestbynid(a) EVP_get_digestbyname(OBJ_nid2sn(a))
#define EVP_get_digestbyobj(a) EVP_get_digestbynid(OBJ_obj2nid(a))
#define EVP_get_cipherbynid(a) EVP_get_cipherbyname(OBJ_nid2sn(a))
#define EVP_get_cipherbyobj(a) EVP_get_cipherbynid(OBJ_obj2nid(a))

int EVP_MD_get_type(const EVP_MD *md);
#define EVP_MD_type EVP_MD_get_type
#define EVP_MD_nid EVP_MD_get_type
const char *EVP_MD_get0_name(const EVP_MD *md);
#define EVP_MD_name EVP_MD_get0_name
const char *EVP_MD_get0_description(const EVP_MD *md);
int EVP_MD_is_a(const EVP_MD *md, const char *name);
int EVP_MD_names_do_all(const EVP_MD *md,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PROVIDER *EVP_MD_get0_provider(const EVP_MD *md);
int EVP_MD_get_pkey_type(const EVP_MD *md);
#define EVP_MD_pkey_type EVP_MD_get_pkey_type
int EVP_MD_get_size(const EVP_MD *md);
#define EVP_MD_size EVP_MD_get_size
int EVP_MD_get_block_size(const EVP_MD *md);
#define EVP_MD_block_size EVP_MD_get_block_size
unsigned long EVP_MD_get_flags(const EVP_MD *md);
#define EVP_MD_flags EVP_MD_get_flags
int EVP_MD_xof(const EVP_MD *md);

const EVP_MD *EVP_MD_CTX_get0_md(const EVP_MD_CTX *ctx);
EVP_MD *EVP_MD_CTX_get1_md(EVP_MD_CTX *ctx);
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
const EVP_MD *EVP_MD_CTX_md(const EVP_MD_CTX *ctx);
OSSL_DEPRECATEDIN_3_0
int (*EVP_MD_CTX_update_fn(EVP_MD_CTX *ctx))(EVP_MD_CTX *ctx,
    const void *data, size_t count);
OSSL_DEPRECATEDIN_3_0
void EVP_MD_CTX_set_update_fn(EVP_MD_CTX *ctx,
    int (*update)(EVP_MD_CTX *ctx,
        const void *data, size_t count));
#endif
int EVP_MD_CTX_get_size_ex(const EVP_MD_CTX *ctx);

#define EVP_MD_CTX_get0_name(e) EVP_MD_get0_name(EVP_MD_CTX_get0_md(e))
#define EVP_MD_CTX_get_size(e) EVP_MD_CTX_get_size_ex(e)
#define EVP_MD_CTX_size EVP_MD_CTX_get_size_ex
#define EVP_MD_CTX_get_block_size(e) EVP_MD_get_block_size(EVP_MD_CTX_get0_md(e))
#define EVP_MD_CTX_block_size EVP_MD_CTX_get_block_size
#define EVP_MD_CTX_get_type(e) EVP_MD_get_type(EVP_MD_CTX_get0_md(e))
#define EVP_MD_CTX_type EVP_MD_CTX_get_type
EVP_PKEY_CTX *EVP_MD_CTX_get_pkey_ctx(const EVP_MD_CTX *ctx);
#define EVP_MD_CTX_pkey_ctx EVP_MD_CTX_get_pkey_ctx
void EVP_MD_CTX_set_pkey_ctx(EVP_MD_CTX *ctx, EVP_PKEY_CTX *pctx);
void *EVP_MD_CTX_get0_md_data(const EVP_MD_CTX *ctx);
#define EVP_MD_CTX_md_data EVP_MD_CTX_get0_md_data

int EVP_CIPHER_get_nid(const EVP_CIPHER *cipher);
#define EVP_CIPHER_nid EVP_CIPHER_get_nid
const char *EVP_CIPHER_get0_name(const EVP_CIPHER *cipher);
#define EVP_CIPHER_name EVP_CIPHER_get0_name
const char *EVP_CIPHER_get0_description(const EVP_CIPHER *cipher);
int EVP_CIPHER_is_a(const EVP_CIPHER *cipher, const char *name);
int EVP_CIPHER_names_do_all(const EVP_CIPHER *cipher,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PROVIDER *EVP_CIPHER_get0_provider(const EVP_CIPHER *cipher);
int EVP_CIPHER_get_block_size(const EVP_CIPHER *cipher);
#define EVP_CIPHER_block_size EVP_CIPHER_get_block_size
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
int EVP_CIPHER_impl_ctx_size(const EVP_CIPHER *cipher);
#endif
int EVP_CIPHER_get_key_length(const EVP_CIPHER *cipher);
#define EVP_CIPHER_key_length EVP_CIPHER_get_key_length
int EVP_CIPHER_get_iv_length(const EVP_CIPHER *cipher);
#define EVP_CIPHER_iv_length EVP_CIPHER_get_iv_length
unsigned long EVP_CIPHER_get_flags(const EVP_CIPHER *cipher);
#define EVP_CIPHER_flags EVP_CIPHER_get_flags
int EVP_CIPHER_get_mode(const EVP_CIPHER *cipher);
#define EVP_CIPHER_mode EVP_CIPHER_get_mode
int EVP_CIPHER_get_type(const EVP_CIPHER *cipher);
#define EVP_CIPHER_type EVP_CIPHER_get_type
EVP_CIPHER *EVP_CIPHER_fetch(OSSL_LIB_CTX *ctx, const char *algorithm,
    const char *properties);
int EVP_CIPHER_can_pipeline(const EVP_CIPHER *cipher, int enc);
int EVP_CIPHER_up_ref(EVP_CIPHER *cipher);
void EVP_CIPHER_free(EVP_CIPHER *cipher);

const EVP_CIPHER *EVP_CIPHER_CTX_get0_cipher(const EVP_CIPHER_CTX *ctx);
EVP_CIPHER *EVP_CIPHER_CTX_get1_cipher(EVP_CIPHER_CTX *ctx);
int EVP_CIPHER_CTX_is_encrypting(const EVP_CIPHER_CTX *ctx);
#define EVP_CIPHER_CTX_encrypting EVP_CIPHER_CTX_is_encrypting
int EVP_CIPHER_CTX_get_nid(const EVP_CIPHER_CTX *ctx);
#define EVP_CIPHER_CTX_nid EVP_CIPHER_CTX_get_nid
int EVP_CIPHER_CTX_get_block_size(const EVP_CIPHER_CTX *ctx);
#define EVP_CIPHER_CTX_block_size EVP_CIPHER_CTX_get_block_size
int EVP_CIPHER_CTX_get_key_length(const EVP_CIPHER_CTX *ctx);
#define EVP_CIPHER_CTX_key_length EVP_CIPHER_CTX_get_key_length
int EVP_CIPHER_CTX_get_iv_length(const EVP_CIPHER_CTX *ctx);
#define EVP_CIPHER_CTX_iv_length EVP_CIPHER_CTX_get_iv_length
int EVP_CIPHER_CTX_get_tag_length(const EVP_CIPHER_CTX *ctx);
#define EVP_CIPHER_CTX_tag_length EVP_CIPHER_CTX_get_tag_length
#ifndef OPENSSL_NO_DEPRECATED_3_0
const EVP_CIPHER *EVP_CIPHER_CTX_cipher(const EVP_CIPHER_CTX *ctx);
OSSL_DEPRECATEDIN_3_0 const unsigned char *EVP_CIPHER_CTX_iv(const EVP_CIPHER_CTX *ctx);
OSSL_DEPRECATEDIN_3_0 const unsigned char *EVP_CIPHER_CTX_original_iv(const EVP_CIPHER_CTX *ctx);
OSSL_DEPRECATEDIN_3_0 unsigned char *EVP_CIPHER_CTX_iv_noconst(EVP_CIPHER_CTX *ctx);
#endif
int EVP_CIPHER_CTX_get_updated_iv(EVP_CIPHER_CTX *ctx, void *buf, size_t len);
int EVP_CIPHER_CTX_get_original_iv(EVP_CIPHER_CTX *ctx, void *buf, size_t len);
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
unsigned char *EVP_CIPHER_CTX_buf_noconst(EVP_CIPHER_CTX *ctx);
#endif
int EVP_CIPHER_CTX_get_num(const EVP_CIPHER_CTX *ctx);
#define EVP_CIPHER_CTX_num EVP_CIPHER_CTX_get_num
int EVP_CIPHER_CTX_set_num(EVP_CIPHER_CTX *ctx, int num);
EVP_CIPHER_CTX *EVP_CIPHER_CTX_dup(const EVP_CIPHER_CTX *in);
int EVP_CIPHER_CTX_copy(EVP_CIPHER_CTX *out, const EVP_CIPHER_CTX *in);
void *EVP_CIPHER_CTX_get_app_data(const EVP_CIPHER_CTX *ctx);
void EVP_CIPHER_CTX_set_app_data(EVP_CIPHER_CTX *ctx, void *data);
void *EVP_CIPHER_CTX_get_cipher_data(const EVP_CIPHER_CTX *ctx);
void *EVP_CIPHER_CTX_set_cipher_data(EVP_CIPHER_CTX *ctx, void *cipher_data);
#define EVP_CIPHER_CTX_get0_name(c) EVP_CIPHER_get0_name(EVP_CIPHER_CTX_get0_cipher(c))
#define EVP_CIPHER_CTX_get_type(c) EVP_CIPHER_get_type(EVP_CIPHER_CTX_get0_cipher(c))
#define EVP_CIPHER_CTX_type EVP_CIPHER_CTX_get_type
#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define EVP_CIPHER_CTX_flags(c) EVP_CIPHER_get_flags(EVP_CIPHER_CTX_get0_cipher(c))
#endif
#define EVP_CIPHER_CTX_get_mode(c) EVP_CIPHER_get_mode(EVP_CIPHER_CTX_get0_cipher(c))
#define EVP_CIPHER_CTX_mode EVP_CIPHER_CTX_get_mode

#define EVP_ENCODE_LENGTH(l) ((((l) + 2) / 3 * 4) + ((l) / 48 + 1) * 2 + 80)
#define EVP_DECODE_LENGTH(l) (((l) + 3) / 4 * 3 + 80)

#define EVP_SignInit_ex(a, b, c) EVP_DigestInit_ex(a, b, c)
#define EVP_SignInit(a, b) EVP_DigestInit(a, b)
#define EVP_SignUpdate(a, b, c) EVP_DigestUpdate(a, b, c)
#define EVP_VerifyInit_ex(a, b, c) EVP_DigestInit_ex(a, b, c)
#define EVP_VerifyInit(a, b) EVP_DigestInit(a, b)
#define EVP_VerifyUpdate(a, b, c) EVP_DigestUpdate(a, b, c)
#define EVP_OpenUpdate(a, b, c, d, e) EVP_DecryptUpdate(a, b, c, d, e)
#define EVP_SealUpdate(a, b, c, d, e) EVP_EncryptUpdate(a, b, c, d, e)

#ifdef CONST_STRICT
void BIO_set_md(BIO *, const EVP_MD *md);
#else
#define BIO_set_md(b, md) BIO_ctrl(b, BIO_C_SET_MD, 0, (void *)(md))
#endif
#define BIO_get_md(b, mdp) BIO_ctrl(b, BIO_C_GET_MD, 0, (mdp))
#define BIO_get_md_ctx(b, mdcp) BIO_ctrl(b, BIO_C_GET_MD_CTX, 0, (mdcp))
#define BIO_set_md_ctx(b, mdcp) BIO_ctrl(b, BIO_C_SET_MD_CTX, 0, (mdcp))
#define BIO_get_cipher_status(b) BIO_ctrl(b, BIO_C_GET_CIPHER_STATUS, 0, NULL)
#define BIO_get_cipher_ctx(b, c_pp) BIO_ctrl(b, BIO_C_GET_CIPHER_CTX, 0, (c_pp))

__owur int EVP_Cipher(EVP_CIPHER_CTX *c,
    unsigned char *out,
    const unsigned char *in, unsigned int inl);

#define EVP_add_cipher_alias(n, alias) \
    OBJ_NAME_add((alias), OBJ_NAME_TYPE_CIPHER_METH | OBJ_NAME_ALIAS, (n))
#define EVP_add_digest_alias(n, alias) \
    OBJ_NAME_add((alias), OBJ_NAME_TYPE_MD_METH | OBJ_NAME_ALIAS, (n))
#define EVP_delete_cipher_alias(alias) \
    OBJ_NAME_remove(alias, OBJ_NAME_TYPE_CIPHER_METH | OBJ_NAME_ALIAS);
#define EVP_delete_digest_alias(alias) \
    OBJ_NAME_remove(alias, OBJ_NAME_TYPE_MD_METH | OBJ_NAME_ALIAS);

int EVP_MD_get_params(const EVP_MD *digest, OSSL_PARAM params[]);
int EVP_MD_CTX_set_params(EVP_MD_CTX *ctx, const OSSL_PARAM params[]);
int EVP_MD_CTX_get_params(EVP_MD_CTX *ctx, OSSL_PARAM params[]);
const OSSL_PARAM *EVP_MD_gettable_params(const EVP_MD *digest);
const OSSL_PARAM *EVP_MD_settable_ctx_params(const EVP_MD *md);
const OSSL_PARAM *EVP_MD_gettable_ctx_params(const EVP_MD *md);
const OSSL_PARAM *EVP_MD_CTX_settable_params(EVP_MD_CTX *ctx);
const OSSL_PARAM *EVP_MD_CTX_gettable_params(EVP_MD_CTX *ctx);
int EVP_MD_CTX_ctrl(EVP_MD_CTX *ctx, int cmd, int p1, void *p2);
EVP_MD_CTX *EVP_MD_CTX_new(void);
int EVP_MD_CTX_reset(EVP_MD_CTX *ctx);
void EVP_MD_CTX_free(EVP_MD_CTX *ctx);
#define EVP_MD_CTX_create() EVP_MD_CTX_new()
#define EVP_MD_CTX_init(ctx) EVP_MD_CTX_reset((ctx))
#define EVP_MD_CTX_destroy(ctx) EVP_MD_CTX_free((ctx))
__owur EVP_MD_CTX *EVP_MD_CTX_dup(const EVP_MD_CTX *in);
__owur int EVP_MD_CTX_copy_ex(EVP_MD_CTX *out, const EVP_MD_CTX *in);
void EVP_MD_CTX_set_flags(EVP_MD_CTX *ctx, int flags);
void EVP_MD_CTX_clear_flags(EVP_MD_CTX *ctx, int flags);
int EVP_MD_CTX_test_flags(const EVP_MD_CTX *ctx, int flags);
__owur int EVP_DigestInit_ex2(EVP_MD_CTX *ctx, const EVP_MD *type,
    const OSSL_PARAM params[]);
__owur int EVP_DigestInit_ex(EVP_MD_CTX *ctx, const EVP_MD *type,
    ENGINE *impl);
__owur int EVP_DigestUpdate(EVP_MD_CTX *ctx, const void *d,
    size_t cnt);
__owur int EVP_DigestFinal_ex(EVP_MD_CTX *ctx, unsigned char *md,
    unsigned int *s);
__owur int EVP_Digest(const void *data, size_t count,
    unsigned char *md, unsigned int *size,
    const EVP_MD *type, ENGINE *impl);
__owur int EVP_Q_digest(OSSL_LIB_CTX *libctx, const char *name,
    const char *propq, const void *data, size_t datalen,
    unsigned char *md, size_t *mdlen);

__owur int EVP_MD_CTX_copy(EVP_MD_CTX *out, const EVP_MD_CTX *in);
__owur int EVP_DigestInit(EVP_MD_CTX *ctx, const EVP_MD *type);
__owur int EVP_DigestFinal(EVP_MD_CTX *ctx, unsigned char *md,
    unsigned int *s);
__owur int EVP_DigestFinalXOF(EVP_MD_CTX *ctx, unsigned char *out,
    size_t outlen);
__owur int EVP_DigestSqueeze(EVP_MD_CTX *ctx, unsigned char *out,
    size_t outlen);

__owur EVP_MD *EVP_MD_fetch(OSSL_LIB_CTX *ctx, const char *algorithm,
    const char *properties);

int EVP_MD_up_ref(EVP_MD *md);
void EVP_MD_free(EVP_MD *md);

int EVP_read_pw_string(char *buf, int length, const char *prompt, int verify);
int EVP_read_pw_string_min(char *buf, int minlen, int maxlen,
    const char *prompt, int verify);
void EVP_set_pw_prompt(const char *prompt);
char *EVP_get_pw_prompt(void);

__owur int EVP_BytesToKey(const EVP_CIPHER *type, const EVP_MD *md,
    const unsigned char *salt,
    const unsigned char *data, int datal, int count,
    unsigned char *key, unsigned char *iv);

void EVP_CIPHER_CTX_set_flags(EVP_CIPHER_CTX *ctx, int flags);
void EVP_CIPHER_CTX_clear_flags(EVP_CIPHER_CTX *ctx, int flags);
int EVP_CIPHER_CTX_test_flags(const EVP_CIPHER_CTX *ctx, int flags);

__owur int EVP_EncryptInit(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *cipher,
    const unsigned char *key, const unsigned char *iv);
__owur int EVP_EncryptInit_ex(EVP_CIPHER_CTX *ctx,
    const EVP_CIPHER *cipher, ENGINE *impl,
    const unsigned char *key,
    const unsigned char *iv);
__owur int EVP_EncryptInit_ex2(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *cipher,
    const unsigned char *key,
    const unsigned char *iv,
    const OSSL_PARAM params[]);
__owur int EVP_EncryptUpdate(EVP_CIPHER_CTX *ctx, unsigned char *out,
    int *outl, const unsigned char *in, int inl);
__owur int EVP_EncryptFinal_ex(EVP_CIPHER_CTX *ctx, unsigned char *out,
    int *outl);
__owur int EVP_EncryptFinal(EVP_CIPHER_CTX *ctx, unsigned char *out,
    int *outl);

__owur int EVP_DecryptInit(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *cipher,
    const unsigned char *key, const unsigned char *iv);
__owur int EVP_DecryptInit_ex(EVP_CIPHER_CTX *ctx,
    const EVP_CIPHER *cipher, ENGINE *impl,
    const unsigned char *key,
    const unsigned char *iv);
__owur int EVP_DecryptInit_ex2(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *cipher,
    const unsigned char *key,
    const unsigned char *iv,
    const OSSL_PARAM params[]);
__owur int EVP_DecryptUpdate(EVP_CIPHER_CTX *ctx, unsigned char *out,
    int *outl, const unsigned char *in, int inl);
__owur int EVP_DecryptFinal(EVP_CIPHER_CTX *ctx, unsigned char *outm,
    int *outl);
__owur int EVP_DecryptFinal_ex(EVP_CIPHER_CTX *ctx, unsigned char *outm,
    int *outl);

__owur int EVP_CipherInit(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *cipher,
    const unsigned char *key, const unsigned char *iv,
    int enc);
__owur int EVP_CipherInit_ex(EVP_CIPHER_CTX *ctx,
    const EVP_CIPHER *cipher, ENGINE *impl,
    const unsigned char *key,
    const unsigned char *iv, int enc);
__owur int EVP_CipherInit_SKEY(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *cipher,
    EVP_SKEY *skey, const unsigned char *iv, size_t iv_len,
    int enc, const OSSL_PARAM params[]);
__owur int EVP_CipherInit_ex2(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *cipher,
    const unsigned char *key, const unsigned char *iv,
    int enc, const OSSL_PARAM params[]);
__owur int EVP_CipherUpdate(EVP_CIPHER_CTX *ctx, unsigned char *out,
    int *outl, const unsigned char *in, int inl);
__owur int EVP_CipherFinal(EVP_CIPHER_CTX *ctx, unsigned char *outm,
    int *outl);
__owur int EVP_CipherPipelineEncryptInit(EVP_CIPHER_CTX *ctx,
    const EVP_CIPHER *cipher,
    const unsigned char *key, size_t keylen,
    size_t numpipes,
    const unsigned char **iv, size_t ivlen);
__owur int EVP_CipherPipelineDecryptInit(EVP_CIPHER_CTX *ctx,
    const EVP_CIPHER *cipher,
    const unsigned char *key, size_t keylen,
    size_t numpipes,
    const unsigned char **iv, size_t ivlen);
__owur int EVP_CipherPipelineUpdate(EVP_CIPHER_CTX *ctx,
    unsigned char **out, size_t *outl,
    const size_t *outsize,
    const unsigned char **in, const size_t *inl);
__owur int EVP_CipherPipelineFinal(EVP_CIPHER_CTX *ctx,
    unsigned char **outm, size_t *outl,
    const size_t *outsize);
__owur int EVP_CipherFinal_ex(EVP_CIPHER_CTX *ctx, unsigned char *outm,
    int *outl);

__owur int EVP_SignFinal(EVP_MD_CTX *ctx, unsigned char *md, unsigned int *s,
    EVP_PKEY *pkey);
__owur int EVP_SignFinal_ex(EVP_MD_CTX *ctx, unsigned char *md, unsigned int *s,
    EVP_PKEY *pkey, OSSL_LIB_CTX *libctx,
    const char *propq);

__owur int EVP_DigestSign(EVP_MD_CTX *ctx, unsigned char *sigret,
    size_t *siglen, const unsigned char *tbs,
    size_t tbslen);

__owur int EVP_VerifyFinal(EVP_MD_CTX *ctx, const unsigned char *sigbuf,
    unsigned int siglen, EVP_PKEY *pkey);
__owur int EVP_VerifyFinal_ex(EVP_MD_CTX *ctx, const unsigned char *sigbuf,
    unsigned int siglen, EVP_PKEY *pkey,
    OSSL_LIB_CTX *libctx, const char *propq);

__owur int EVP_DigestVerify(EVP_MD_CTX *ctx, const unsigned char *sigret,
    size_t siglen, const unsigned char *tbs,
    size_t tbslen);

__owur int EVP_DigestSignInit_ex(EVP_MD_CTX *ctx, EVP_PKEY_CTX **pctx,
    const char *mdname, OSSL_LIB_CTX *libctx,
    const char *props, EVP_PKEY *pkey,
    const OSSL_PARAM params[]);
__owur int EVP_DigestSignInit(EVP_MD_CTX *ctx, EVP_PKEY_CTX **pctx,
    const EVP_MD *type, ENGINE *e,
    EVP_PKEY *pkey);
__owur int EVP_DigestSignUpdate(EVP_MD_CTX *ctx, const void *data, size_t dsize);
__owur int EVP_DigestSignFinal(EVP_MD_CTX *ctx, unsigned char *sigret,
    size_t *siglen);

__owur int EVP_DigestVerifyInit_ex(EVP_MD_CTX *ctx, EVP_PKEY_CTX **pctx,
    const char *mdname, OSSL_LIB_CTX *libctx,
    const char *props, EVP_PKEY *pkey,
    const OSSL_PARAM params[]);
__owur int EVP_DigestVerifyInit(EVP_MD_CTX *ctx, EVP_PKEY_CTX **pctx,
    const EVP_MD *type, ENGINE *e,
    EVP_PKEY *pkey);
int EVP_DigestVerifyUpdate(EVP_MD_CTX *ctx, const void *data, size_t dsize);
__owur int EVP_DigestVerifyFinal(EVP_MD_CTX *ctx, const unsigned char *sig,
    size_t siglen);

__owur int EVP_OpenInit(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *type,
    const unsigned char *ek, int ekl,
    const unsigned char *iv, EVP_PKEY *priv);
__owur int EVP_OpenFinal(EVP_CIPHER_CTX *ctx, unsigned char *out, int *outl);

__owur int EVP_SealInit(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *type,
    unsigned char **ek, int *ekl, unsigned char *iv,
    EVP_PKEY **pubk, int npubk);
__owur int EVP_SealFinal(EVP_CIPHER_CTX *ctx, unsigned char *out, int *outl);

EVP_ENCODE_CTX *EVP_ENCODE_CTX_new(void);
void EVP_ENCODE_CTX_free(EVP_ENCODE_CTX *ctx);
int EVP_ENCODE_CTX_copy(EVP_ENCODE_CTX *dctx, const EVP_ENCODE_CTX *sctx);
int EVP_ENCODE_CTX_num(EVP_ENCODE_CTX *ctx);
void EVP_EncodeInit(EVP_ENCODE_CTX *ctx);
int EVP_EncodeUpdate(EVP_ENCODE_CTX *ctx, unsigned char *out, int *outl,
    const unsigned char *in, int inl);
void EVP_EncodeFinal(EVP_ENCODE_CTX *ctx, unsigned char *out, int *outl);
int EVP_EncodeBlock(unsigned char *t, const unsigned char *f, int n);

void EVP_DecodeInit(EVP_ENCODE_CTX *ctx);
int EVP_DecodeUpdate(EVP_ENCODE_CTX *ctx, unsigned char *out, int *outl,
    const unsigned char *in, int inl);
int EVP_DecodeFinal(EVP_ENCODE_CTX *ctx, unsigned char *out, int *outl);
int EVP_DecodeBlock(unsigned char *t, const unsigned char *f, int n);

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define EVP_CIPHER_CTX_init(c) EVP_CIPHER_CTX_reset(c)
#define EVP_CIPHER_CTX_cleanup(c) EVP_CIPHER_CTX_reset(c)
#endif
EVP_CIPHER_CTX *EVP_CIPHER_CTX_new(void);
int EVP_CIPHER_CTX_reset(EVP_CIPHER_CTX *c);
void EVP_CIPHER_CTX_free(EVP_CIPHER_CTX *c);
int EVP_CIPHER_CTX_set_key_length(EVP_CIPHER_CTX *x, int keylen);
int EVP_CIPHER_CTX_set_padding(EVP_CIPHER_CTX *c, int pad);
int EVP_CIPHER_CTX_ctrl(EVP_CIPHER_CTX *ctx, int type, int arg, void *ptr);
int EVP_CIPHER_CTX_rand_key(EVP_CIPHER_CTX *ctx, unsigned char *key);
int EVP_CIPHER_get_params(EVP_CIPHER *cipher, OSSL_PARAM params[]);
int EVP_CIPHER_CTX_set_params(EVP_CIPHER_CTX *ctx, const OSSL_PARAM params[]);
int EVP_CIPHER_CTX_get_params(EVP_CIPHER_CTX *ctx, OSSL_PARAM params[]);
const OSSL_PARAM *EVP_CIPHER_gettable_params(const EVP_CIPHER *cipher);
const OSSL_PARAM *EVP_CIPHER_settable_ctx_params(const EVP_CIPHER *cipher);
const OSSL_PARAM *EVP_CIPHER_gettable_ctx_params(const EVP_CIPHER *cipher);
const OSSL_PARAM *EVP_CIPHER_CTX_settable_params(EVP_CIPHER_CTX *ctx);
const OSSL_PARAM *EVP_CIPHER_CTX_gettable_params(EVP_CIPHER_CTX *ctx);

int EVP_CIPHER_CTX_set_algor_params(EVP_CIPHER_CTX *ctx, const X509_ALGOR *alg);
int EVP_CIPHER_CTX_get_algor_params(EVP_CIPHER_CTX *ctx, X509_ALGOR *alg);
int EVP_CIPHER_CTX_get_algor(EVP_CIPHER_CTX *ctx, X509_ALGOR **alg);

const BIO_METHOD *BIO_f_md(void);
const BIO_METHOD *BIO_f_base64(void);
const BIO_METHOD *BIO_f_cipher(void);
const BIO_METHOD *BIO_f_reliable(void);
__owur int BIO_set_cipher(BIO *b, const EVP_CIPHER *c, const unsigned char *k,
    const unsigned char *i, int enc);

const EVP_MD *EVP_md_null(void);
#ifndef OPENSSL_NO_MD2
const EVP_MD *EVP_md2(void);
#endif
#ifndef OPENSSL_NO_MD4
const EVP_MD *EVP_md4(void);
#endif
#ifndef OPENSSL_NO_MD5
const EVP_MD *EVP_md5(void);
const EVP_MD *EVP_md5_sha1(void);
#endif
#ifndef OPENSSL_NO_BLAKE2
const EVP_MD *EVP_blake2b512(void);
const EVP_MD *EVP_blake2s256(void);
#endif
const EVP_MD *EVP_sha1(void);
const EVP_MD *EVP_sha224(void);
const EVP_MD *EVP_sha256(void);
const EVP_MD *EVP_sha384(void);
const EVP_MD *EVP_sha512(void);
const EVP_MD *EVP_sha512_224(void);
const EVP_MD *EVP_sha512_256(void);
const EVP_MD *EVP_sha3_224(void);
const EVP_MD *EVP_sha3_256(void);
const EVP_MD *EVP_sha3_384(void);
const EVP_MD *EVP_sha3_512(void);
const EVP_MD *EVP_shake128(void);
const EVP_MD *EVP_shake256(void);

#ifndef OPENSSL_NO_MDC2
const EVP_MD *EVP_mdc2(void);
#endif
#ifndef OPENSSL_NO_RMD160
const EVP_MD *EVP_ripemd160(void);
#endif
#ifndef OPENSSL_NO_WHIRLPOOL
const EVP_MD *EVP_whirlpool(void);
#endif
#ifndef OPENSSL_NO_SM3
const EVP_MD *EVP_sm3(void);
#endif
const EVP_CIPHER *EVP_enc_null(void); /* does nothing :-) */
#ifndef OPENSSL_NO_DES
const EVP_CIPHER *EVP_des_ecb(void);
const EVP_CIPHER *EVP_des_ede(void);
const EVP_CIPHER *EVP_des_ede3(void);
const EVP_CIPHER *EVP_des_ede_ecb(void);
const EVP_CIPHER *EVP_des_ede3_ecb(void);
const EVP_CIPHER *EVP_des_cfb64(void);
#define EVP_des_cfb EVP_des_cfb64
const EVP_CIPHER *EVP_des_cfb1(void);
const EVP_CIPHER *EVP_des_cfb8(void);
const EVP_CIPHER *EVP_des_ede_cfb64(void);
#define EVP_des_ede_cfb EVP_des_ede_cfb64
const EVP_CIPHER *EVP_des_ede3_cfb64(void);
#define EVP_des_ede3_cfb EVP_des_ede3_cfb64
const EVP_CIPHER *EVP_des_ede3_cfb1(void);
const EVP_CIPHER *EVP_des_ede3_cfb8(void);
const EVP_CIPHER *EVP_des_ofb(void);
const EVP_CIPHER *EVP_des_ede_ofb(void);
const EVP_CIPHER *EVP_des_ede3_ofb(void);
const EVP_CIPHER *EVP_des_cbc(void);
const EVP_CIPHER *EVP_des_ede_cbc(void);
const EVP_CIPHER *EVP_des_ede3_cbc(void);
const EVP_CIPHER *EVP_desx_cbc(void);
const EVP_CIPHER *EVP_des_ede3_wrap(void);
/*
 * This should now be supported through the dev_crypto ENGINE. But also, why
 * are rc4 and md5 declarations made here inside a "NO_DES" precompiler
 * branch?
 */
#endif
#ifndef OPENSSL_NO_RC4
const EVP_CIPHER *EVP_rc4(void);
const EVP_CIPHER *EVP_rc4_40(void);
#ifndef OPENSSL_NO_MD5
const EVP_CIPHER *EVP_rc4_hmac_md5(void);
#endif
#endif
#ifndef OPENSSL_NO_IDEA
const EVP_CIPHER *EVP_idea_ecb(void);
const EVP_CIPHER *EVP_idea_cfb64(void);
#define EVP_idea_cfb EVP_idea_cfb64
const EVP_CIPHER *EVP_idea_ofb(void);
const EVP_CIPHER *EVP_idea_cbc(void);
#endif
#ifndef OPENSSL_NO_RC2
const EVP_CIPHER *EVP_rc2_ecb(void);
const EVP_CIPHER *EVP_rc2_cbc(void);
const EVP_CIPHER *EVP_rc2_40_cbc(void);
const EVP_CIPHER *EVP_rc2_64_cbc(void);
const EVP_CIPHER *EVP_rc2_cfb64(void);
#define EVP_rc2_cfb EVP_rc2_cfb64
const EVP_CIPHER *EVP_rc2_ofb(void);
#endif
#ifndef OPENSSL_NO_BF
const EVP_CIPHER *EVP_bf_ecb(void);
const EVP_CIPHER *EVP_bf_cbc(void);
const EVP_CIPHER *EVP_bf_cfb64(void);
#define EVP_bf_cfb EVP_bf_cfb64
const EVP_CIPHER *EVP_bf_ofb(void);
#endif
#ifndef OPENSSL_NO_CAST
const EVP_CIPHER *EVP_cast5_ecb(void);
const EVP_CIPHER *EVP_cast5_cbc(void);
const EVP_CIPHER *EVP_cast5_cfb64(void);
#define EVP_cast5_cfb EVP_cast5_cfb64
const EVP_CIPHER *EVP_cast5_ofb(void);
#endif
#ifndef OPENSSL_NO_RC5
const EVP_CIPHER *EVP_rc5_32_12_16_cbc(void);
const EVP_CIPHER *EVP_rc5_32_12_16_ecb(void);
const EVP_CIPHER *EVP_rc5_32_12_16_cfb64(void);
#define EVP_rc5_32_12_16_cfb EVP_rc5_32_12_16_cfb64
const EVP_CIPHER *EVP_rc5_32_12_16_ofb(void);
#endif
const EVP_CIPHER *EVP_aes_128_ecb(void);
const EVP_CIPHER *EVP_aes_128_cbc(void);
const EVP_CIPHER *EVP_aes_128_cfb1(void);
const EVP_CIPHER *EVP_aes_128_cfb8(void);
const EVP_CIPHER *EVP_aes_128_cfb128(void);
#define EVP_aes_128_cfb EVP_aes_128_cfb128
const EVP_CIPHER *EVP_aes_128_ofb(void);
const EVP_CIPHER *EVP_aes_128_ctr(void);
const EVP_CIPHER *EVP_aes_128_ccm(void);
const EVP_CIPHER *EVP_aes_128_gcm(void);
const EVP_CIPHER *EVP_aes_128_xts(void);
const EVP_CIPHER *EVP_aes_128_wrap(void);
const EVP_CIPHER *EVP_aes_128_wrap_pad(void);
#ifndef OPENSSL_NO_OCB
const EVP_CIPHER *EVP_aes_128_ocb(void);
#endif
const EVP_CIPHER *EVP_aes_192_ecb(void);
const EVP_CIPHER *EVP_aes_192_cbc(void);
const EVP_CIPHER *EVP_aes_192_cfb1(void);
const EVP_CIPHER *EVP_aes_192_cfb8(void);
const EVP_CIPHER *EVP_aes_192_cfb128(void);
#define EVP_aes_192_cfb EVP_aes_192_cfb128
const EVP_CIPHER *EVP_aes_192_ofb(void);
const EVP_CIPHER *EVP_aes_192_ctr(void);
const EVP_CIPHER *EVP_aes_192_ccm(void);
const EVP_CIPHER *EVP_aes_192_gcm(void);
const EVP_CIPHER *EVP_aes_192_wrap(void);
const EVP_CIPHER *EVP_aes_192_wrap_pad(void);
#ifndef OPENSSL_NO_OCB
const EVP_CIPHER *EVP_aes_192_ocb(void);
#endif
const EVP_CIPHER *EVP_aes_256_ecb(void);
const EVP_CIPHER *EVP_aes_256_cbc(void);
const EVP_CIPHER *EVP_aes_256_cfb1(void);
const EVP_CIPHER *EVP_aes_256_cfb8(void);
const EVP_CIPHER *EVP_aes_256_cfb128(void);
#define EVP_aes_256_cfb EVP_aes_256_cfb128
const EVP_CIPHER *EVP_aes_256_ofb(void);
const EVP_CIPHER *EVP_aes_256_ctr(void);
const EVP_CIPHER *EVP_aes_256_ccm(void);
const EVP_CIPHER *EVP_aes_256_gcm(void);
const EVP_CIPHER *EVP_aes_256_xts(void);
const EVP_CIPHER *EVP_aes_256_wrap(void);
const EVP_CIPHER *EVP_aes_256_wrap_pad(void);
#ifndef OPENSSL_NO_OCB
const EVP_CIPHER *EVP_aes_256_ocb(void);
#endif
const EVP_CIPHER *EVP_aes_128_cbc_hmac_sha1(void);
const EVP_CIPHER *EVP_aes_256_cbc_hmac_sha1(void);
const EVP_CIPHER *EVP_aes_128_cbc_hmac_sha256(void);
const EVP_CIPHER *EVP_aes_256_cbc_hmac_sha256(void);
#ifndef OPENSSL_NO_ARIA
const EVP_CIPHER *EVP_aria_128_ecb(void);
const EVP_CIPHER *EVP_aria_128_cbc(void);
const EVP_CIPHER *EVP_aria_128_cfb1(void);
const EVP_CIPHER *EVP_aria_128_cfb8(void);
const EVP_CIPHER *EVP_aria_128_cfb128(void);
#define EVP_aria_128_cfb EVP_aria_128_cfb128
const EVP_CIPHER *EVP_aria_128_ctr(void);
const EVP_CIPHER *EVP_aria_128_ofb(void);
const EVP_CIPHER *EVP_aria_128_gcm(void);
const EVP_CIPHER *EVP_aria_128_ccm(void);
const EVP_CIPHER *EVP_aria_192_ecb(void);
const EVP_CIPHER *EVP_aria_192_cbc(void);
const EVP_CIPHER *EVP_aria_192_cfb1(void);
const EVP_CIPHER *EVP_aria_192_cfb8(void);
const EVP_CIPHER *EVP_aria_192_cfb128(void);
#define EVP_aria_192_cfb EVP_aria_192_cfb128
const EVP_CIPHER *EVP_aria_192_ctr(void);
const EVP_CIPHER *EVP_aria_192_ofb(void);
const EVP_CIPHER *EVP_aria_192_gcm(void);
const EVP_CIPHER *EVP_aria_192_ccm(void);
const EVP_CIPHER *EVP_aria_256_ecb(void);
const EVP_CIPHER *EVP_aria_256_cbc(void);
const EVP_CIPHER *EVP_aria_256_cfb1(void);
const EVP_CIPHER *EVP_aria_256_cfb8(void);
const EVP_CIPHER *EVP_aria_256_cfb128(void);
#define EVP_aria_256_cfb EVP_aria_256_cfb128
const EVP_CIPHER *EVP_aria_256_ctr(void);
const EVP_CIPHER *EVP_aria_256_ofb(void);
const EVP_CIPHER *EVP_aria_256_gcm(void);
const EVP_CIPHER *EVP_aria_256_ccm(void);
#endif
#ifndef OPENSSL_NO_CAMELLIA
const EVP_CIPHER *EVP_camellia_128_ecb(void);
const EVP_CIPHER *EVP_camellia_128_cbc(void);
const EVP_CIPHER *EVP_camellia_128_cfb1(void);
const EVP_CIPHER *EVP_camellia_128_cfb8(void);
const EVP_CIPHER *EVP_camellia_128_cfb128(void);
#define EVP_camellia_128_cfb EVP_camellia_128_cfb128
const EVP_CIPHER *EVP_camellia_128_ofb(void);
const EVP_CIPHER *EVP_camellia_128_ctr(void);
const EVP_CIPHER *EVP_camellia_192_ecb(void);
const EVP_CIPHER *EVP_camellia_192_cbc(void);
const EVP_CIPHER *EVP_camellia_192_cfb1(void);
const EVP_CIPHER *EVP_camellia_192_cfb8(void);
const EVP_CIPHER *EVP_camellia_192_cfb128(void);
#define EVP_camellia_192_cfb EVP_camellia_192_cfb128
const EVP_CIPHER *EVP_camellia_192_ofb(void);
const EVP_CIPHER *EVP_camellia_192_ctr(void);
const EVP_CIPHER *EVP_camellia_256_ecb(void);
const EVP_CIPHER *EVP_camellia_256_cbc(void);
const EVP_CIPHER *EVP_camellia_256_cfb1(void);
const EVP_CIPHER *EVP_camellia_256_cfb8(void);
const EVP_CIPHER *EVP_camellia_256_cfb128(void);
#define EVP_camellia_256_cfb EVP_camellia_256_cfb128
const EVP_CIPHER *EVP_camellia_256_ofb(void);
const EVP_CIPHER *EVP_camellia_256_ctr(void);
#endif
#ifndef OPENSSL_NO_CHACHA
const EVP_CIPHER *EVP_chacha20(void);
#ifndef OPENSSL_NO_POLY1305
const EVP_CIPHER *EVP_chacha20_poly1305(void);
#endif
#endif

#ifndef OPENSSL_NO_SEED
const EVP_CIPHER *EVP_seed_ecb(void);
const EVP_CIPHER *EVP_seed_cbc(void);
const EVP_CIPHER *EVP_seed_cfb128(void);
#define EVP_seed_cfb EVP_seed_cfb128
const EVP_CIPHER *EVP_seed_ofb(void);
#endif

#ifndef OPENSSL_NO_SM4
const EVP_CIPHER *EVP_sm4_ecb(void);
const EVP_CIPHER *EVP_sm4_cbc(void);
const EVP_CIPHER *EVP_sm4_cfb128(void);
#define EVP_sm4_cfb EVP_sm4_cfb128
const EVP_CIPHER *EVP_sm4_ofb(void);
const EVP_CIPHER *EVP_sm4_ctr(void);
#endif

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define OPENSSL_add_all_algorithms_conf()            \
    OPENSSL_init_crypto(OPENSSL_INIT_ADD_ALL_CIPHERS \
            | OPENSSL_INIT_ADD_ALL_DIGESTS           \
            | OPENSSL_INIT_LOAD_CONFIG,              \
        NULL)
#define OPENSSL_add_all_algorithms_noconf()          \
    OPENSSL_init_crypto(OPENSSL_INIT_ADD_ALL_CIPHERS \
            | OPENSSL_INIT_ADD_ALL_DIGESTS,          \
        NULL)

#ifdef OPENSSL_LOAD_CONF
#define OpenSSL_add_all_algorithms() OPENSSL_add_all_algorithms_conf()
#else
#define OpenSSL_add_all_algorithms() OPENSSL_add_all_algorithms_noconf()
#endif

#define OpenSSL_add_all_ciphers() \
    OPENSSL_init_crypto(OPENSSL_INIT_ADD_ALL_CIPHERS, NULL)
#define OpenSSL_add_all_digests() \
    OPENSSL_init_crypto(OPENSSL_INIT_ADD_ALL_DIGESTS, NULL)

#define EVP_cleanup() \
    while (0)         \
    continue
#endif

int EVP_add_cipher(const EVP_CIPHER *cipher);
int EVP_add_digest(const EVP_MD *digest);

const EVP_CIPHER *EVP_get_cipherbyname(const char *name);
const EVP_MD *EVP_get_digestbyname(const char *name);

void EVP_CIPHER_do_all(void (*fn)(const EVP_CIPHER *ciph,
                           const char *from, const char *to, void *x),
    void *arg);
void EVP_CIPHER_do_all_sorted(void (*fn)(const EVP_CIPHER *ciph, const char *from,
                                  const char *to, void *x),
    void *arg);
void EVP_CIPHER_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_CIPHER *cipher, void *arg),
    void *arg);

void EVP_MD_do_all(void (*fn)(const EVP_MD *ciph,
                       const char *from, const char *to, void *x),
    void *arg);
void EVP_MD_do_all_sorted(void (*fn)(const EVP_MD *ciph, const char *from,
                              const char *to, void *x),
    void *arg);
void EVP_MD_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_MD *md, void *arg),
    void *arg);

/* MAC stuff */

EVP_MAC *EVP_MAC_fetch(OSSL_LIB_CTX *libctx, const char *algorithm,
    const char *properties);
int EVP_MAC_up_ref(EVP_MAC *mac);
void EVP_MAC_free(EVP_MAC *mac);
const char *EVP_MAC_get0_name(const EVP_MAC *mac);
const char *EVP_MAC_get0_description(const EVP_MAC *mac);
int EVP_MAC_is_a(const EVP_MAC *mac, const char *name);
const OSSL_PROVIDER *EVP_MAC_get0_provider(const EVP_MAC *mac);
int EVP_MAC_get_params(EVP_MAC *mac, OSSL_PARAM params[]);

EVP_MAC_CTX *EVP_MAC_CTX_new(EVP_MAC *mac);
void EVP_MAC_CTX_free(EVP_MAC_CTX *ctx);
EVP_MAC_CTX *EVP_MAC_CTX_dup(const EVP_MAC_CTX *src);
EVP_MAC *EVP_MAC_CTX_get0_mac(EVP_MAC_CTX *ctx);
int EVP_MAC_CTX_get_params(EVP_MAC_CTX *ctx, OSSL_PARAM params[]);
int EVP_MAC_CTX_set_params(EVP_MAC_CTX *ctx, const OSSL_PARAM params[]);

size_t EVP_MAC_CTX_get_mac_size(EVP_MAC_CTX *ctx);
size_t EVP_MAC_CTX_get_block_size(EVP_MAC_CTX *ctx);
unsigned char *EVP_Q_mac(OSSL_LIB_CTX *libctx, const char *name, const char *propq,
    const char *subalg, const OSSL_PARAM *params,
    const void *key, size_t keylen,
    const unsigned char *data, size_t datalen,
    unsigned char *out, size_t outsize, size_t *outlen);
int EVP_MAC_init(EVP_MAC_CTX *ctx, const unsigned char *key, size_t keylen,
    const OSSL_PARAM params[]);
int EVP_MAC_init_SKEY(EVP_MAC_CTX *ctx, EVP_SKEY *skey, const OSSL_PARAM params[]);
int EVP_MAC_update(EVP_MAC_CTX *ctx, const unsigned char *data, size_t datalen);
int EVP_MAC_final(EVP_MAC_CTX *ctx,
    unsigned char *out, size_t *outl, size_t outsize);
int EVP_MAC_finalXOF(EVP_MAC_CTX *ctx, unsigned char *out, size_t outsize);
const OSSL_PARAM *EVP_MAC_gettable_params(const EVP_MAC *mac);
const OSSL_PARAM *EVP_MAC_gettable_ctx_params(const EVP_MAC *mac);
const OSSL_PARAM *EVP_MAC_settable_ctx_params(const EVP_MAC *mac);
const OSSL_PARAM *EVP_MAC_CTX_gettable_params(EVP_MAC_CTX *ctx);
const OSSL_PARAM *EVP_MAC_CTX_settable_params(EVP_MAC_CTX *ctx);

void EVP_MAC_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_MAC *mac, void *arg),
    void *arg);
int EVP_MAC_names_do_all(const EVP_MAC *mac,
    void (*fn)(const char *name, void *data),
    void *data);

/* RAND stuff */
EVP_RAND *EVP_RAND_fetch(OSSL_LIB_CTX *libctx, const char *algorithm,
    const char *properties);
int EVP_RAND_up_ref(EVP_RAND *rand);
void EVP_RAND_free(EVP_RAND *rand);
const char *EVP_RAND_get0_name(const EVP_RAND *rand);
const char *EVP_RAND_get0_description(const EVP_RAND *md);
int EVP_RAND_is_a(const EVP_RAND *rand, const char *name);
const OSSL_PROVIDER *EVP_RAND_get0_provider(const EVP_RAND *rand);
int EVP_RAND_get_params(EVP_RAND *rand, OSSL_PARAM params[]);

EVP_RAND_CTX *EVP_RAND_CTX_new(EVP_RAND *rand, EVP_RAND_CTX *parent);
int EVP_RAND_CTX_up_ref(EVP_RAND_CTX *ctx);
void EVP_RAND_CTX_free(EVP_RAND_CTX *ctx);
EVP_RAND *EVP_RAND_CTX_get0_rand(EVP_RAND_CTX *ctx);
int EVP_RAND_CTX_get_params(EVP_RAND_CTX *ctx, OSSL_PARAM params[]);
int EVP_RAND_CTX_set_params(EVP_RAND_CTX *ctx, const OSSL_PARAM params[]);
const OSSL_PARAM *EVP_RAND_gettable_params(const EVP_RAND *rand);
const OSSL_PARAM *EVP_RAND_gettable_ctx_params(const EVP_RAND *rand);
const OSSL_PARAM *EVP_RAND_settable_ctx_params(const EVP_RAND *rand);
const OSSL_PARAM *EVP_RAND_CTX_gettable_params(EVP_RAND_CTX *ctx);
const OSSL_PARAM *EVP_RAND_CTX_settable_params(EVP_RAND_CTX *ctx);

void EVP_RAND_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_RAND *rand, void *arg),
    void *arg);
int EVP_RAND_names_do_all(const EVP_RAND *rand,
    void (*fn)(const char *name, void *data),
    void *data);

__owur int EVP_RAND_instantiate(EVP_RAND_CTX *ctx, unsigned int strength,
    int prediction_resistance,
    const unsigned char *pstr, size_t pstr_len,
    const OSSL_PARAM params[]);
int EVP_RAND_uninstantiate(EVP_RAND_CTX *ctx);
__owur int EVP_RAND_generate(EVP_RAND_CTX *ctx, unsigned char *out,
    size_t outlen, unsigned int strength,
    int prediction_resistance,
    const unsigned char *addin, size_t addin_len);
int EVP_RAND_reseed(EVP_RAND_CTX *ctx, int prediction_resistance,
    const unsigned char *ent, size_t ent_len,
    const unsigned char *addin, size_t addin_len);
__owur int EVP_RAND_nonce(EVP_RAND_CTX *ctx, unsigned char *out, size_t outlen);
__owur int EVP_RAND_enable_locking(EVP_RAND_CTX *ctx);

int EVP_RAND_verify_zeroization(EVP_RAND_CTX *ctx);
unsigned int EVP_RAND_get_strength(EVP_RAND_CTX *ctx);
int EVP_RAND_get_state(EVP_RAND_CTX *ctx);

#define EVP_RAND_STATE_UNINITIALISED 0
#define EVP_RAND_STATE_READY 1
#define EVP_RAND_STATE_ERROR 2

/* PKEY stuff */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int EVP_PKEY_decrypt_old(unsigned char *dec_key,
    const unsigned char *enc_key,
    int enc_key_len,
    EVP_PKEY *private_key);
OSSL_DEPRECATEDIN_3_0 int EVP_PKEY_encrypt_old(unsigned char *enc_key,
    const unsigned char *key,
    int key_len, EVP_PKEY *pub_key);
#endif
int EVP_PKEY_is_a(const EVP_PKEY *pkey, const char *name);
int EVP_PKEY_type_names_do_all(const EVP_PKEY *pkey,
    void (*fn)(const char *name, void *data),
    void *data);
int EVP_PKEY_type(int type);
int EVP_PKEY_get_id(const EVP_PKEY *pkey);
#define EVP_PKEY_id EVP_PKEY_get_id
int EVP_PKEY_get_base_id(const EVP_PKEY *pkey);
#define EVP_PKEY_base_id EVP_PKEY_get_base_id
int EVP_PKEY_get_bits(const EVP_PKEY *pkey);
#define EVP_PKEY_bits EVP_PKEY_get_bits
int EVP_PKEY_get_security_bits(const EVP_PKEY *pkey);
#define EVP_PKEY_security_bits EVP_PKEY_get_security_bits
int EVP_PKEY_get_security_category(const EVP_PKEY *pkey);
int EVP_PKEY_get_size(const EVP_PKEY *pkey);
#define EVP_PKEY_size EVP_PKEY_get_size
int EVP_PKEY_can_sign(const EVP_PKEY *pkey);
int EVP_PKEY_set_type(EVP_PKEY *pkey, int type);
int EVP_PKEY_set_type_str(EVP_PKEY *pkey, const char *str, int len);
int EVP_PKEY_set_type_by_keymgmt(EVP_PKEY *pkey, EVP_KEYMGMT *keymgmt);
#ifndef OPENSSL_NO_DEPRECATED_3_0
#ifndef OPENSSL_NO_ENGINE
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_set1_engine(EVP_PKEY *pkey, ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE *EVP_PKEY_get0_engine(const EVP_PKEY *pkey);
#endif
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_assign(EVP_PKEY *pkey, int type, void *key);
OSSL_DEPRECATEDIN_3_0
void *EVP_PKEY_get0(const EVP_PKEY *pkey);
OSSL_DEPRECATEDIN_3_0
const unsigned char *EVP_PKEY_get0_hmac(const EVP_PKEY *pkey, size_t *len);
#ifndef OPENSSL_NO_POLY1305
OSSL_DEPRECATEDIN_3_0
const unsigned char *EVP_PKEY_get0_poly1305(const EVP_PKEY *pkey, size_t *len);
#endif
#ifndef OPENSSL_NO_SIPHASH
OSSL_DEPRECATEDIN_3_0
const unsigned char *EVP_PKEY_get0_siphash(const EVP_PKEY *pkey, size_t *len);
#endif

struct rsa_st;
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_set1_RSA(EVP_PKEY *pkey, struct rsa_st *key);
OSSL_DEPRECATEDIN_3_0
const struct rsa_st *EVP_PKEY_get0_RSA(const EVP_PKEY *pkey);
OSSL_DEPRECATEDIN_3_0
struct rsa_st *EVP_PKEY_get1_RSA(EVP_PKEY *pkey);

#ifndef OPENSSL_NO_DSA
struct dsa_st;
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_set1_DSA(EVP_PKEY *pkey, struct dsa_st *key);
OSSL_DEPRECATEDIN_3_0
const struct dsa_st *EVP_PKEY_get0_DSA(const EVP_PKEY *pkey);
OSSL_DEPRECATEDIN_3_0
struct dsa_st *EVP_PKEY_get1_DSA(EVP_PKEY *pkey);
#endif

#ifndef OPENSSL_NO_DH
struct dh_st;
OSSL_DEPRECATEDIN_3_0 int EVP_PKEY_set1_DH(EVP_PKEY *pkey, struct dh_st *key);
OSSL_DEPRECATEDIN_3_0 const struct dh_st *EVP_PKEY_get0_DH(const EVP_PKEY *pkey);
OSSL_DEPRECATEDIN_3_0 struct dh_st *EVP_PKEY_get1_DH(EVP_PKEY *pkey);
#endif

#ifndef OPENSSL_NO_EC
struct ec_key_st;
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_set1_EC_KEY(EVP_PKEY *pkey, struct ec_key_st *key);
OSSL_DEPRECATEDIN_3_0
const struct ec_key_st *EVP_PKEY_get0_EC_KEY(const EVP_PKEY *pkey);
OSSL_DEPRECATEDIN_3_0
struct ec_key_st *EVP_PKEY_get1_EC_KEY(EVP_PKEY *pkey);
#endif
#endif /* OPENSSL_NO_DEPRECATED_3_0 */

EVP_PKEY *EVP_PKEY_new(void);
int EVP_PKEY_up_ref(EVP_PKEY *pkey);
EVP_PKEY *EVP_PKEY_dup(EVP_PKEY *pkey);
void EVP_PKEY_free(EVP_PKEY *pkey);
const char *EVP_PKEY_get0_description(const EVP_PKEY *pkey);
const OSSL_PROVIDER *EVP_PKEY_get0_provider(const EVP_PKEY *key);

EVP_PKEY *d2i_PublicKey(int type, EVP_PKEY **a, const unsigned char **pp,
    long length);
int i2d_PublicKey(const EVP_PKEY *a, unsigned char **pp);

EVP_PKEY *d2i_PrivateKey_ex(int type, EVP_PKEY **a, const unsigned char **pp,
    long length, OSSL_LIB_CTX *libctx,
    const char *propq);
EVP_PKEY *d2i_PrivateKey(int type, EVP_PKEY **a, const unsigned char **pp,
    long length);
EVP_PKEY *d2i_AutoPrivateKey_ex(EVP_PKEY **a, const unsigned char **pp,
    long length, OSSL_LIB_CTX *libctx,
    const char *propq);
EVP_PKEY *d2i_AutoPrivateKey(EVP_PKEY **a, const unsigned char **pp,
    long length);
int i2d_PrivateKey(const EVP_PKEY *a, unsigned char **pp);
int i2d_PKCS8PrivateKey(const EVP_PKEY *a, unsigned char **pp);

int i2d_KeyParams(const EVP_PKEY *a, unsigned char **pp);
EVP_PKEY *d2i_KeyParams(int type, EVP_PKEY **a, const unsigned char **pp,
    long length);
int i2d_KeyParams_bio(BIO *bp, const EVP_PKEY *pkey);
EVP_PKEY *d2i_KeyParams_bio(int type, EVP_PKEY **a, BIO *in);

int EVP_PKEY_copy_parameters(EVP_PKEY *to, const EVP_PKEY *from);
int EVP_PKEY_missing_parameters(const EVP_PKEY *pkey);
int EVP_PKEY_save_parameters(EVP_PKEY *pkey, int mode);
int EVP_PKEY_parameters_eq(const EVP_PKEY *a, const EVP_PKEY *b);
int EVP_PKEY_eq(const EVP_PKEY *a, const EVP_PKEY *b);

#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_cmp_parameters(const EVP_PKEY *a, const EVP_PKEY *b);
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_cmp(const EVP_PKEY *a, const EVP_PKEY *b);
#endif

int EVP_PKEY_print_public(BIO *out, const EVP_PKEY *pkey,
    int indent, ASN1_PCTX *pctx);
int EVP_PKEY_print_private(BIO *out, const EVP_PKEY *pkey,
    int indent, ASN1_PCTX *pctx);
int EVP_PKEY_print_params(BIO *out, const EVP_PKEY *pkey,
    int indent, ASN1_PCTX *pctx);
#ifndef OPENSSL_NO_STDIO
int EVP_PKEY_print_public_fp(FILE *fp, const EVP_PKEY *pkey,
    int indent, ASN1_PCTX *pctx);
int EVP_PKEY_print_private_fp(FILE *fp, const EVP_PKEY *pkey,
    int indent, ASN1_PCTX *pctx);
int EVP_PKEY_print_params_fp(FILE *fp, const EVP_PKEY *pkey,
    int indent, ASN1_PCTX *pctx);
#endif

int EVP_PKEY_get_default_digest_nid(EVP_PKEY *pkey, int *pnid);
int EVP_PKEY_get_default_digest_name(EVP_PKEY *pkey,
    char *mdname, size_t mdname_sz);
int EVP_PKEY_digestsign_supports_digest(EVP_PKEY *pkey, OSSL_LIB_CTX *libctx,
    const char *name, const char *propq);

#ifndef OPENSSL_NO_DEPRECATED_3_0
/*
 * For backwards compatibility. Use EVP_PKEY_set1_encoded_public_key in
 * preference
 */
#define EVP_PKEY_set1_tls_encodedpoint(pkey, pt, ptlen) \
    EVP_PKEY_set1_encoded_public_key((pkey), (pt), (ptlen))
#endif

int EVP_PKEY_set1_encoded_public_key(EVP_PKEY *pkey,
    const unsigned char *pub, size_t publen);

#ifndef OPENSSL_NO_DEPRECATED_3_0
/*
 * For backwards compatibility. Use EVP_PKEY_get1_encoded_public_key in
 * preference
 */
#define EVP_PKEY_get1_tls_encodedpoint(pkey, ppt) \
    EVP_PKEY_get1_encoded_public_key((pkey), (ppt))
#endif

size_t EVP_PKEY_get1_encoded_public_key(EVP_PKEY *pkey, unsigned char **ppub);

/* calls methods */
int EVP_CIPHER_param_to_asn1(EVP_CIPHER_CTX *c, ASN1_TYPE *type);
int EVP_CIPHER_asn1_to_param(EVP_CIPHER_CTX *c, ASN1_TYPE *type);

/* These are used by EVP_CIPHER methods */
int EVP_CIPHER_set_asn1_iv(EVP_CIPHER_CTX *c, ASN1_TYPE *type);
int EVP_CIPHER_get_asn1_iv(EVP_CIPHER_CTX *c, ASN1_TYPE *type);

/* PKCS5 password based encryption */
int PKCS5_PBE_keyivgen(EVP_CIPHER_CTX *ctx, const char *pass, int passlen,
    ASN1_TYPE *param, const EVP_CIPHER *cipher,
    const EVP_MD *md, int en_de);
int PKCS5_PBE_keyivgen_ex(EVP_CIPHER_CTX *cctx, const char *pass, int passlen,
    ASN1_TYPE *param, const EVP_CIPHER *cipher,
    const EVP_MD *md, int en_de, OSSL_LIB_CTX *libctx,
    const char *propq);
int PKCS5_PBKDF2_HMAC_SHA1(const char *pass, int passlen,
    const unsigned char *salt, int saltlen, int iter,
    int keylen, unsigned char *out);
int PKCS5_PBKDF2_HMAC(const char *pass, int passlen,
    const unsigned char *salt, int saltlen, int iter,
    const EVP_MD *digest, int keylen, unsigned char *out);
int PKCS5_v2_PBE_keyivgen(EVP_CIPHER_CTX *ctx, const char *pass, int passlen,
    ASN1_TYPE *param, const EVP_CIPHER *cipher,
    const EVP_MD *md, int en_de);
int PKCS5_v2_PBE_keyivgen_ex(EVP_CIPHER_CTX *ctx, const char *pass, int passlen,
    ASN1_TYPE *param, const EVP_CIPHER *cipher,
    const EVP_MD *md, int en_de,
    OSSL_LIB_CTX *libctx, const char *propq);

#ifndef OPENSSL_NO_SCRYPT
int EVP_PBE_scrypt(const char *pass, size_t passlen,
    const unsigned char *salt, size_t saltlen,
    uint64_t N, uint64_t r, uint64_t p, uint64_t maxmem,
    unsigned char *key, size_t keylen);
int EVP_PBE_scrypt_ex(const char *pass, size_t passlen,
    const unsigned char *salt, size_t saltlen,
    uint64_t N, uint64_t r, uint64_t p, uint64_t maxmem,
    unsigned char *key, size_t keylen,
    OSSL_LIB_CTX *ctx, const char *propq);

int PKCS5_v2_scrypt_keyivgen(EVP_CIPHER_CTX *ctx, const char *pass,
    int passlen, ASN1_TYPE *param,
    const EVP_CIPHER *c, const EVP_MD *md, int en_de);
int PKCS5_v2_scrypt_keyivgen_ex(EVP_CIPHER_CTX *ctx, const char *pass,
    int passlen, ASN1_TYPE *param,
    const EVP_CIPHER *c, const EVP_MD *md, int en_de,
    OSSL_LIB_CTX *libctx, const char *propq);
#endif

void PKCS5_PBE_add(void);

int EVP_PBE_CipherInit(ASN1_OBJECT *pbe_obj, const char *pass, int passlen,
    ASN1_TYPE *param, EVP_CIPHER_CTX *ctx, int en_de);

int EVP_PBE_CipherInit_ex(ASN1_OBJECT *pbe_obj, const char *pass, int passlen,
    ASN1_TYPE *param, EVP_CIPHER_CTX *ctx, int en_de,
    OSSL_LIB_CTX *libctx, const char *propq);

/* PBE type */

/* Can appear as the outermost AlgorithmIdentifier */
#define EVP_PBE_TYPE_OUTER 0x0
/* Is an PRF type OID */
#define EVP_PBE_TYPE_PRF 0x1
/* Is a PKCS#5 v2.0 KDF */
#define EVP_PBE_TYPE_KDF 0x2

int EVP_PBE_alg_add_type(int pbe_type, int pbe_nid, int cipher_nid,
    int md_nid, EVP_PBE_KEYGEN *keygen);
int EVP_PBE_alg_add(int nid, const EVP_CIPHER *cipher, const EVP_MD *md,
    EVP_PBE_KEYGEN *keygen);
int EVP_PBE_find(int type, int pbe_nid, int *pcnid, int *pmnid,
    EVP_PBE_KEYGEN **pkeygen);
int EVP_PBE_find_ex(int type, int pbe_nid, int *pcnid, int *pmnid,
    EVP_PBE_KEYGEN **pkeygen, EVP_PBE_KEYGEN_EX **pkeygen_ex);
void EVP_PBE_cleanup(void);
int EVP_PBE_get(int *ptype, int *ppbe_nid, size_t num);

#define ASN1_PKEY_ALIAS 0x1
#define ASN1_PKEY_DYNAMIC 0x2
#define ASN1_PKEY_SIGPARAM_NULL 0x4

#define ASN1_PKEY_CTRL_PKCS7_SIGN 0x1
#define ASN1_PKEY_CTRL_PKCS7_ENCRYPT 0x2
#define ASN1_PKEY_CTRL_DEFAULT_MD_NID 0x3
#define ASN1_PKEY_CTRL_CMS_SIGN 0x5
#define ASN1_PKEY_CTRL_CMS_ENVELOPE 0x7
#define ASN1_PKEY_CTRL_CMS_RI_TYPE 0x8

#define ASN1_PKEY_CTRL_SET1_TLS_ENCPT 0x9
#define ASN1_PKEY_CTRL_GET1_TLS_ENCPT 0xa
#define ASN1_PKEY_CTRL_CMS_IS_RI_TYPE_SUPPORTED 0xb

#ifndef OPENSSL_NO_DEPRECATED_3_6
OSSL_DEPRECATEDIN_3_6 int EVP_PKEY_asn1_get_count(void);
OSSL_DEPRECATEDIN_3_6 const EVP_PKEY_ASN1_METHOD *EVP_PKEY_asn1_get0(int idx);
OSSL_DEPRECATEDIN_3_6
const EVP_PKEY_ASN1_METHOD *EVP_PKEY_asn1_find(ENGINE **pe, int type);
OSSL_DEPRECATEDIN_3_6
const EVP_PKEY_ASN1_METHOD *EVP_PKEY_asn1_find_str(ENGINE **pe,
    const char *str, int len);
OSSL_DEPRECATEDIN_3_6 int EVP_PKEY_asn1_add0(const EVP_PKEY_ASN1_METHOD *ameth);
OSSL_DEPRECATEDIN_3_6 int EVP_PKEY_asn1_add_alias(int to, int from);
OSSL_DEPRECATEDIN_3_6
int EVP_PKEY_asn1_get0_info(int *ppkey_id, int *pkey_base_id,
    int *ppkey_flags, const char **pinfo,
    const char **ppem_str,
    const EVP_PKEY_ASN1_METHOD *ameth);

OSSL_DEPRECATEDIN_3_6 const EVP_PKEY_ASN1_METHOD *EVP_PKEY_get0_asn1(const EVP_PKEY *pkey);
OSSL_DEPRECATEDIN_3_6 EVP_PKEY_ASN1_METHOD *EVP_PKEY_asn1_new(int id, int flags,
    const char *pem_str,
    const char *info);
OSSL_DEPRECATEDIN_3_6 void EVP_PKEY_asn1_copy(EVP_PKEY_ASN1_METHOD *dst,
    const EVP_PKEY_ASN1_METHOD *src);
OSSL_DEPRECATEDIN_3_6 void EVP_PKEY_asn1_free(EVP_PKEY_ASN1_METHOD *ameth);
OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_public(EVP_PKEY_ASN1_METHOD *ameth,
    int (*pub_decode)(EVP_PKEY *pk,
        const X509_PUBKEY *pub),
    int (*pub_encode)(X509_PUBKEY *pub,
        const EVP_PKEY *pk),
    int (*pub_cmp)(const EVP_PKEY *a,
        const EVP_PKEY *b),
    int (*pub_print)(BIO *out,
        const EVP_PKEY *pkey,
        int indent, ASN1_PCTX *pctx),
    int (*pkey_size)(const EVP_PKEY *pk),
    int (*pkey_bits)(const EVP_PKEY *pk));
OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_private(EVP_PKEY_ASN1_METHOD *ameth,
    int (*priv_decode)(EVP_PKEY *pk,
        const PKCS8_PRIV_KEY_INFO
            *p8inf),
    int (*priv_encode)(PKCS8_PRIV_KEY_INFO *p8,
        const EVP_PKEY *pk),
    int (*priv_print)(BIO *out,
        const EVP_PKEY *pkey,
        int indent,
        ASN1_PCTX *pctx));
OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_param(EVP_PKEY_ASN1_METHOD *ameth,
    int (*param_decode)(EVP_PKEY *pkey,
        const unsigned char **pder,
        int derlen),
    int (*param_encode)(const EVP_PKEY *pkey,
        unsigned char **pder),
    int (*param_missing)(const EVP_PKEY *pk),
    int (*param_copy)(EVP_PKEY *to,
        const EVP_PKEY *from),
    int (*param_cmp)(const EVP_PKEY *a,
        const EVP_PKEY *b),
    int (*param_print)(BIO *out,
        const EVP_PKEY *pkey,
        int indent,
        ASN1_PCTX *pctx));

OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_free(EVP_PKEY_ASN1_METHOD *ameth,
    void (*pkey_free)(EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_ctrl(EVP_PKEY_ASN1_METHOD *ameth,
    int (*pkey_ctrl)(EVP_PKEY *pkey, int op,
        long arg1, void *arg2));
OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_item(EVP_PKEY_ASN1_METHOD *ameth,
    int (*item_verify)(EVP_MD_CTX *ctx,
        const ASN1_ITEM *it,
        const void *data,
        const X509_ALGOR *a,
        const ASN1_BIT_STRING *sig,
        EVP_PKEY *pkey),
    int (*item_sign)(EVP_MD_CTX *ctx,
        const ASN1_ITEM *it,
        const void *data,
        X509_ALGOR *alg1,
        X509_ALGOR *alg2,
        ASN1_BIT_STRING *sig));

OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_siginf(EVP_PKEY_ASN1_METHOD *ameth,
    int (*siginf_set)(X509_SIG_INFO *siginf,
        const X509_ALGOR *alg,
        const ASN1_STRING *sig));

OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_check(EVP_PKEY_ASN1_METHOD *ameth,
    int (*pkey_check)(const EVP_PKEY *pk));

OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_public_check(EVP_PKEY_ASN1_METHOD *ameth,
    int (*pkey_pub_check)(const EVP_PKEY *pk));

OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_param_check(EVP_PKEY_ASN1_METHOD *ameth,
    int (*pkey_param_check)(const EVP_PKEY *pk));

OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_set_priv_key(EVP_PKEY_ASN1_METHOD *ameth,
    int (*set_priv_key)(EVP_PKEY *pk,
        const unsigned char
            *priv,
        size_t len));
OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_set_pub_key(EVP_PKEY_ASN1_METHOD *ameth,
    int (*set_pub_key)(EVP_PKEY *pk,
        const unsigned char *pub,
        size_t len));
OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_get_priv_key(EVP_PKEY_ASN1_METHOD *ameth,
    int (*get_priv_key)(const EVP_PKEY *pk,
        unsigned char *priv,
        size_t *len));
OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_get_pub_key(EVP_PKEY_ASN1_METHOD *ameth,
    int (*get_pub_key)(const EVP_PKEY *pk,
        unsigned char *pub,
        size_t *len));

OSSL_DEPRECATEDIN_3_6
void EVP_PKEY_asn1_set_security_bits(EVP_PKEY_ASN1_METHOD *ameth,
    int (*pkey_security_bits)(const EVP_PKEY
            *pk));
#endif /* OPENSSL_NO_DEPRECATED_3_6 */

int EVP_PKEY_CTX_get_signature_md(EVP_PKEY_CTX *ctx, const EVP_MD **md);
int EVP_PKEY_CTX_set_signature_md(EVP_PKEY_CTX *ctx, const EVP_MD *md);

int EVP_PKEY_CTX_set1_id(EVP_PKEY_CTX *ctx, const void *id, int len);
int EVP_PKEY_CTX_get1_id(EVP_PKEY_CTX *ctx, void *id);
int EVP_PKEY_CTX_get1_id_len(EVP_PKEY_CTX *ctx, size_t *id_len);

int EVP_PKEY_CTX_set_kem_op(EVP_PKEY_CTX *ctx, const char *op);

const char *EVP_PKEY_get0_type_name(const EVP_PKEY *key);

#define EVP_PKEY_OP_UNDEFINED 0
#define EVP_PKEY_OP_PARAMGEN (1 << 1)
#define EVP_PKEY_OP_KEYGEN (1 << 2)
#define EVP_PKEY_OP_FROMDATA (1 << 3)
#define EVP_PKEY_OP_SIGN (1 << 4)
#define EVP_PKEY_OP_VERIFY (1 << 5)
#define EVP_PKEY_OP_VERIFYRECOVER (1 << 6)
#define EVP_PKEY_OP_SIGNCTX (1 << 7)
#define EVP_PKEY_OP_VERIFYCTX (1 << 8)
#define EVP_PKEY_OP_ENCRYPT (1 << 9)
#define EVP_PKEY_OP_DECRYPT (1 << 10)
#define EVP_PKEY_OP_DERIVE (1 << 11)
#define EVP_PKEY_OP_ENCAPSULATE (1 << 12)
#define EVP_PKEY_OP_DECAPSULATE (1 << 13)
#define EVP_PKEY_OP_SIGNMSG (1 << 14)
#define EVP_PKEY_OP_VERIFYMSG (1 << 15)
/* Update the following when adding new EVP_PKEY_OPs */
#define EVP_PKEY_OP_ALL ((1 << 16) - 1)

#define EVP_PKEY_OP_TYPE_SIG                         \
    (EVP_PKEY_OP_SIGN | EVP_PKEY_OP_SIGNMSG          \
        | EVP_PKEY_OP_VERIFY | EVP_PKEY_OP_VERIFYMSG \
        | EVP_PKEY_OP_VERIFYRECOVER                  \
        | EVP_PKEY_OP_SIGNCTX | EVP_PKEY_OP_VERIFYCTX)

#define EVP_PKEY_OP_TYPE_CRYPT \
    (EVP_PKEY_OP_ENCRYPT | EVP_PKEY_OP_DECRYPT)

#define EVP_PKEY_OP_TYPE_DERIVE \
    (EVP_PKEY_OP_DERIVE)

#define EVP_PKEY_OP_TYPE_DATA \
    (EVP_PKEY_OP_FROMDATA)

#define EVP_PKEY_OP_TYPE_KEM \
    (EVP_PKEY_OP_ENCAPSULATE | EVP_PKEY_OP_DECAPSULATE)

#define EVP_PKEY_OP_TYPE_GEN \
    (EVP_PKEY_OP_PARAMGEN | EVP_PKEY_OP_KEYGEN)

#define EVP_PKEY_OP_TYPE_NOGEN \
    (EVP_PKEY_OP_ALL & ~EVP_PKEY_OP_TYPE_GEN)

int EVP_PKEY_CTX_set_mac_key(EVP_PKEY_CTX *ctx, const unsigned char *key,
    int keylen);

#define EVP_PKEY_CTRL_MD 1
#define EVP_PKEY_CTRL_PEER_KEY 2
#define EVP_PKEY_CTRL_SET_MAC_KEY 6
#define EVP_PKEY_CTRL_DIGESTINIT 7
/* Used by GOST key encryption in TLS */
#define EVP_PKEY_CTRL_SET_IV 8
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define EVP_PKEY_CTRL_PKCS7_ENCRYPT 3
#define EVP_PKEY_CTRL_PKCS7_DECRYPT 4
#define EVP_PKEY_CTRL_PKCS7_SIGN 5
#define EVP_PKEY_CTRL_CMS_ENCRYPT 9
#define EVP_PKEY_CTRL_CMS_DECRYPT 10
#define EVP_PKEY_CTRL_CMS_SIGN 11
#endif
#define EVP_PKEY_CTRL_CIPHER 12
#define EVP_PKEY_CTRL_GET_MD 13
#define EVP_PKEY_CTRL_SET_DIGEST_SIZE 14
#define EVP_PKEY_CTRL_SET1_ID 15
#define EVP_PKEY_CTRL_GET1_ID 16
#define EVP_PKEY_CTRL_GET1_ID_LEN 17

#define EVP_PKEY_ALG_CTRL 0x1000

#define EVP_PKEY_FLAG_AUTOARGLEN 2
/*
 * Method handles all operations: don't assume any digest related defaults.
 */
#define EVP_PKEY_FLAG_SIGCTX_CUSTOM 4
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 const EVP_PKEY_METHOD *EVP_PKEY_meth_find(int type);
OSSL_DEPRECATEDIN_3_0 EVP_PKEY_METHOD *EVP_PKEY_meth_new(int id, int flags);
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get0_info(int *ppkey_id, int *pflags,
    const EVP_PKEY_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_copy(EVP_PKEY_METHOD *dst,
    const EVP_PKEY_METHOD *src);
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_free(EVP_PKEY_METHOD *pmeth);
OSSL_DEPRECATEDIN_3_0 int EVP_PKEY_meth_add0(const EVP_PKEY_METHOD *pmeth);
OSSL_DEPRECATEDIN_3_0 int EVP_PKEY_meth_remove(const EVP_PKEY_METHOD *pmeth);
OSSL_DEPRECATEDIN_3_0 size_t EVP_PKEY_meth_get_count(void);
OSSL_DEPRECATEDIN_3_0 const EVP_PKEY_METHOD *EVP_PKEY_meth_get0(size_t idx);
#endif

EVP_KEYMGMT *EVP_KEYMGMT_fetch(OSSL_LIB_CTX *ctx, const char *algorithm,
    const char *properties);
int EVP_KEYMGMT_up_ref(EVP_KEYMGMT *keymgmt);
void EVP_KEYMGMT_free(EVP_KEYMGMT *keymgmt);
const OSSL_PROVIDER *EVP_KEYMGMT_get0_provider(const EVP_KEYMGMT *keymgmt);
const char *EVP_KEYMGMT_get0_name(const EVP_KEYMGMT *keymgmt);
const char *EVP_KEYMGMT_get0_description(const EVP_KEYMGMT *keymgmt);
int EVP_KEYMGMT_is_a(const EVP_KEYMGMT *keymgmt, const char *name);
void EVP_KEYMGMT_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_KEYMGMT *keymgmt, void *arg),
    void *arg);
int EVP_KEYMGMT_names_do_all(const EVP_KEYMGMT *keymgmt,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PARAM *EVP_KEYMGMT_gettable_params(const EVP_KEYMGMT *keymgmt);
const OSSL_PARAM *EVP_KEYMGMT_settable_params(const EVP_KEYMGMT *keymgmt);
const OSSL_PARAM *EVP_KEYMGMT_gen_settable_params(const EVP_KEYMGMT *keymgmt);
const OSSL_PARAM *EVP_KEYMGMT_gen_gettable_params(const EVP_KEYMGMT *keymgmt);

EVP_SKEYMGMT *EVP_SKEYMGMT_fetch(OSSL_LIB_CTX *ctx, const char *algorithm,
    const char *properties);
int EVP_SKEYMGMT_up_ref(EVP_SKEYMGMT *keymgmt);
void EVP_SKEYMGMT_free(EVP_SKEYMGMT *keymgmt);
const OSSL_PROVIDER *EVP_SKEYMGMT_get0_provider(const EVP_SKEYMGMT *keymgmt);
const char *EVP_SKEYMGMT_get0_name(const EVP_SKEYMGMT *keymgmt);
const char *EVP_SKEYMGMT_get0_description(const EVP_SKEYMGMT *keymgmt);
int EVP_SKEYMGMT_is_a(const EVP_SKEYMGMT *keymgmt, const char *name);
void EVP_SKEYMGMT_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_SKEYMGMT *keymgmt, void *arg),
    void *arg);
int EVP_SKEYMGMT_names_do_all(const EVP_SKEYMGMT *keymgmt,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PARAM *EVP_SKEYMGMT_get0_gen_settable_params(const EVP_SKEYMGMT *skeymgmt);
const OSSL_PARAM *EVP_SKEYMGMT_get0_imp_settable_params(const EVP_SKEYMGMT *skeymgmt);

EVP_PKEY_CTX *EVP_PKEY_CTX_new(EVP_PKEY *pkey, ENGINE *e);
EVP_PKEY_CTX *EVP_PKEY_CTX_new_id(int id, ENGINE *e);
EVP_PKEY_CTX *EVP_PKEY_CTX_new_from_name(OSSL_LIB_CTX *libctx,
    const char *name,
    const char *propquery);
EVP_PKEY_CTX *EVP_PKEY_CTX_new_from_pkey(OSSL_LIB_CTX *libctx,
    EVP_PKEY *pkey, const char *propquery);
EVP_PKEY_CTX *EVP_PKEY_CTX_dup(const EVP_PKEY_CTX *ctx);
void EVP_PKEY_CTX_free(EVP_PKEY_CTX *ctx);
int EVP_PKEY_CTX_is_a(EVP_PKEY_CTX *ctx, const char *keytype);

int EVP_PKEY_CTX_get_params(EVP_PKEY_CTX *ctx, OSSL_PARAM *params);
const OSSL_PARAM *EVP_PKEY_CTX_gettable_params(const EVP_PKEY_CTX *ctx);
int EVP_PKEY_CTX_set_params(EVP_PKEY_CTX *ctx, const OSSL_PARAM *params);
const OSSL_PARAM *EVP_PKEY_CTX_settable_params(const EVP_PKEY_CTX *ctx);

int EVP_PKEY_CTX_set_algor_params(EVP_PKEY_CTX *ctx, const X509_ALGOR *alg);
int EVP_PKEY_CTX_get_algor_params(EVP_PKEY_CTX *ctx, X509_ALGOR *alg);
int EVP_PKEY_CTX_get_algor(EVP_PKEY_CTX *ctx, X509_ALGOR **alg);

int EVP_PKEY_CTX_ctrl(EVP_PKEY_CTX *ctx, int keytype, int optype,
    int cmd, int p1, void *p2);
int EVP_PKEY_CTX_ctrl_str(EVP_PKEY_CTX *ctx, const char *type,
    const char *value);
int EVP_PKEY_CTX_ctrl_uint64(EVP_PKEY_CTX *ctx, int keytype, int optype,
    int cmd, uint64_t value);

int EVP_PKEY_CTX_str2ctrl(EVP_PKEY_CTX *ctx, int cmd, const char *str);
int EVP_PKEY_CTX_hex2ctrl(EVP_PKEY_CTX *ctx, int cmd, const char *hex);

int EVP_PKEY_CTX_md(EVP_PKEY_CTX *ctx, int optype, int cmd, const char *md);

int EVP_PKEY_CTX_get_operation(EVP_PKEY_CTX *ctx);
void EVP_PKEY_CTX_set0_keygen_info(EVP_PKEY_CTX *ctx, int *dat, int datlen);

EVP_PKEY *EVP_PKEY_new_mac_key(int type, ENGINE *e,
    const unsigned char *key, int keylen);
EVP_PKEY *EVP_PKEY_new_raw_private_key_ex(OSSL_LIB_CTX *libctx,
    const char *keytype,
    const char *propq,
    const unsigned char *priv, size_t len);
EVP_PKEY *EVP_PKEY_new_raw_private_key(int type, ENGINE *e,
    const unsigned char *priv,
    size_t len);
EVP_PKEY *EVP_PKEY_new_raw_public_key_ex(OSSL_LIB_CTX *libctx,
    const char *keytype, const char *propq,
    const unsigned char *pub, size_t len);
EVP_PKEY *EVP_PKEY_new_raw_public_key(int type, ENGINE *e,
    const unsigned char *pub,
    size_t len);
int EVP_PKEY_get_raw_private_key(const EVP_PKEY *pkey, unsigned char *priv,
    size_t *len);
int EVP_PKEY_get_raw_public_key(const EVP_PKEY *pkey, unsigned char *pub,
    size_t *len);

#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
EVP_PKEY *EVP_PKEY_new_CMAC_key(ENGINE *e, const unsigned char *priv,
    size_t len, const EVP_CIPHER *cipher);
#endif

void EVP_PKEY_CTX_set_data(EVP_PKEY_CTX *ctx, void *data);
void *EVP_PKEY_CTX_get_data(const EVP_PKEY_CTX *ctx);
EVP_PKEY *EVP_PKEY_CTX_get0_pkey(EVP_PKEY_CTX *ctx);

EVP_PKEY *EVP_PKEY_CTX_get0_peerkey(EVP_PKEY_CTX *ctx);

void EVP_PKEY_CTX_set_app_data(EVP_PKEY_CTX *ctx, void *data);
void *EVP_PKEY_CTX_get_app_data(EVP_PKEY_CTX *ctx);

int EVP_PKEY_CTX_set_signature(EVP_PKEY_CTX *pctx,
    const unsigned char *sig, size_t siglen);

void EVP_SIGNATURE_free(EVP_SIGNATURE *signature);
int EVP_SIGNATURE_up_ref(EVP_SIGNATURE *signature);
OSSL_PROVIDER *EVP_SIGNATURE_get0_provider(const EVP_SIGNATURE *signature);
EVP_SIGNATURE *EVP_SIGNATURE_fetch(OSSL_LIB_CTX *ctx, const char *algorithm,
    const char *properties);
int EVP_SIGNATURE_is_a(const EVP_SIGNATURE *signature, const char *name);
const char *EVP_SIGNATURE_get0_name(const EVP_SIGNATURE *signature);
const char *EVP_SIGNATURE_get0_description(const EVP_SIGNATURE *signature);
void EVP_SIGNATURE_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_SIGNATURE *signature,
        void *data),
    void *data);
int EVP_SIGNATURE_names_do_all(const EVP_SIGNATURE *signature,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PARAM *EVP_SIGNATURE_gettable_ctx_params(const EVP_SIGNATURE *sig);
const OSSL_PARAM *EVP_SIGNATURE_settable_ctx_params(const EVP_SIGNATURE *sig);

void EVP_ASYM_CIPHER_free(EVP_ASYM_CIPHER *cipher);
int EVP_ASYM_CIPHER_up_ref(EVP_ASYM_CIPHER *cipher);
OSSL_PROVIDER *EVP_ASYM_CIPHER_get0_provider(const EVP_ASYM_CIPHER *cipher);
EVP_ASYM_CIPHER *EVP_ASYM_CIPHER_fetch(OSSL_LIB_CTX *ctx, const char *algorithm,
    const char *properties);
int EVP_ASYM_CIPHER_is_a(const EVP_ASYM_CIPHER *cipher, const char *name);
const char *EVP_ASYM_CIPHER_get0_name(const EVP_ASYM_CIPHER *cipher);
const char *EVP_ASYM_CIPHER_get0_description(const EVP_ASYM_CIPHER *cipher);
void EVP_ASYM_CIPHER_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_ASYM_CIPHER *cipher,
        void *arg),
    void *arg);
int EVP_ASYM_CIPHER_names_do_all(const EVP_ASYM_CIPHER *cipher,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PARAM *EVP_ASYM_CIPHER_gettable_ctx_params(const EVP_ASYM_CIPHER *ciph);
const OSSL_PARAM *EVP_ASYM_CIPHER_settable_ctx_params(const EVP_ASYM_CIPHER *ciph);

void EVP_KEM_free(EVP_KEM *wrap);
int EVP_KEM_up_ref(EVP_KEM *wrap);
OSSL_PROVIDER *EVP_KEM_get0_provider(const EVP_KEM *wrap);
EVP_KEM *EVP_KEM_fetch(OSSL_LIB_CTX *ctx, const char *algorithm,
    const char *properties);
int EVP_KEM_is_a(const EVP_KEM *wrap, const char *name);
const char *EVP_KEM_get0_name(const EVP_KEM *wrap);
const char *EVP_KEM_get0_description(const EVP_KEM *wrap);
void EVP_KEM_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_KEM *wrap, void *arg), void *arg);
int EVP_KEM_names_do_all(const EVP_KEM *wrap,
    void (*fn)(const char *name, void *data), void *data);
const OSSL_PARAM *EVP_KEM_gettable_ctx_params(const EVP_KEM *kem);
const OSSL_PARAM *EVP_KEM_settable_ctx_params(const EVP_KEM *kem);

int EVP_PKEY_sign_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_sign_init_ex(EVP_PKEY_CTX *ctx, const OSSL_PARAM params[]);
int EVP_PKEY_sign_init_ex2(EVP_PKEY_CTX *ctx,
    EVP_SIGNATURE *algo, const OSSL_PARAM params[]);
int EVP_PKEY_sign(EVP_PKEY_CTX *ctx,
    unsigned char *sig, size_t *siglen,
    const unsigned char *tbs, size_t tbslen);
int EVP_PKEY_sign_message_init(EVP_PKEY_CTX *ctx,
    EVP_SIGNATURE *algo, const OSSL_PARAM params[]);
int EVP_PKEY_sign_message_update(EVP_PKEY_CTX *ctx,
    const unsigned char *in, size_t inlen);
int EVP_PKEY_sign_message_final(EVP_PKEY_CTX *ctx,
    unsigned char *sig, size_t *siglen);
int EVP_PKEY_verify_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_verify_init_ex(EVP_PKEY_CTX *ctx, const OSSL_PARAM params[]);
int EVP_PKEY_verify_init_ex2(EVP_PKEY_CTX *ctx,
    EVP_SIGNATURE *algo, const OSSL_PARAM params[]);
int EVP_PKEY_verify(EVP_PKEY_CTX *ctx,
    const unsigned char *sig, size_t siglen,
    const unsigned char *tbs, size_t tbslen);
int EVP_PKEY_verify_message_init(EVP_PKEY_CTX *ctx,
    EVP_SIGNATURE *algo, const OSSL_PARAM params[]);
int EVP_PKEY_verify_message_update(EVP_PKEY_CTX *ctx,
    const unsigned char *in, size_t inlen);
int EVP_PKEY_verify_message_final(EVP_PKEY_CTX *ctx);
int EVP_PKEY_verify_recover_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_verify_recover_init_ex(EVP_PKEY_CTX *ctx,
    const OSSL_PARAM params[]);
int EVP_PKEY_verify_recover_init_ex2(EVP_PKEY_CTX *ctx,
    EVP_SIGNATURE *algo,
    const OSSL_PARAM params[]);
int EVP_PKEY_verify_recover(EVP_PKEY_CTX *ctx,
    unsigned char *rout, size_t *routlen,
    const unsigned char *sig, size_t siglen);
int EVP_PKEY_encrypt_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_encrypt_init_ex(EVP_PKEY_CTX *ctx, const OSSL_PARAM params[]);
int EVP_PKEY_encrypt(EVP_PKEY_CTX *ctx,
    unsigned char *out, size_t *outlen,
    const unsigned char *in, size_t inlen);
int EVP_PKEY_decrypt_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_decrypt_init_ex(EVP_PKEY_CTX *ctx, const OSSL_PARAM params[]);
int EVP_PKEY_decrypt(EVP_PKEY_CTX *ctx,
    unsigned char *out, size_t *outlen,
    const unsigned char *in, size_t inlen);

int EVP_PKEY_derive_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_derive_init_ex(EVP_PKEY_CTX *ctx, const OSSL_PARAM params[]);
int EVP_PKEY_derive_set_peer_ex(EVP_PKEY_CTX *ctx, EVP_PKEY *peer,
    int validate_peer);
int EVP_PKEY_derive_set_peer(EVP_PKEY_CTX *ctx, EVP_PKEY *peer);
int EVP_PKEY_derive(EVP_PKEY_CTX *ctx, unsigned char *key, size_t *keylen);
EVP_SKEY *EVP_PKEY_derive_SKEY(EVP_PKEY_CTX *ctx, EVP_SKEYMGMT *mgmt,
    const char *key_type, const char *propquery,
    size_t keylen, const OSSL_PARAM params[]);

int EVP_PKEY_encapsulate_init(EVP_PKEY_CTX *ctx, const OSSL_PARAM params[]);
int EVP_PKEY_auth_encapsulate_init(EVP_PKEY_CTX *ctx, EVP_PKEY *authpriv,
    const OSSL_PARAM params[]);
int EVP_PKEY_encapsulate(EVP_PKEY_CTX *ctx,
    unsigned char *wrappedkey, size_t *wrappedkeylen,
    unsigned char *genkey, size_t *genkeylen);
int EVP_PKEY_decapsulate_init(EVP_PKEY_CTX *ctx, const OSSL_PARAM params[]);
int EVP_PKEY_auth_decapsulate_init(EVP_PKEY_CTX *ctx, EVP_PKEY *authpub,
    const OSSL_PARAM params[]);
int EVP_PKEY_decapsulate(EVP_PKEY_CTX *ctx,
    unsigned char *unwrapped, size_t *unwrappedlen,
    const unsigned char *wrapped, size_t wrappedlen);
typedef int EVP_PKEY_gen_cb(EVP_PKEY_CTX *ctx);

int EVP_PKEY_fromdata_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_fromdata(EVP_PKEY_CTX *ctx, EVP_PKEY **ppkey, int selection,
    OSSL_PARAM param[]);
const OSSL_PARAM *EVP_PKEY_fromdata_settable(EVP_PKEY_CTX *ctx, int selection);

int EVP_PKEY_todata(const EVP_PKEY *pkey, int selection, OSSL_PARAM **params);
int EVP_PKEY_export(const EVP_PKEY *pkey, int selection,
    OSSL_CALLBACK *export_cb, void *export_cbarg);

const OSSL_PARAM *EVP_PKEY_gettable_params(const EVP_PKEY *pkey);
int EVP_PKEY_get_params(const EVP_PKEY *pkey, OSSL_PARAM params[]);
int EVP_PKEY_get_int_param(const EVP_PKEY *pkey, const char *key_name,
    int *out);
int EVP_PKEY_get_size_t_param(const EVP_PKEY *pkey, const char *key_name,
    size_t *out);
int EVP_PKEY_get_bn_param(const EVP_PKEY *pkey, const char *key_name,
    BIGNUM **bn);
int EVP_PKEY_get_utf8_string_param(const EVP_PKEY *pkey, const char *key_name,
    char *str, size_t max_buf_sz, size_t *out_sz);
int EVP_PKEY_get_octet_string_param(const EVP_PKEY *pkey, const char *key_name,
    unsigned char *buf, size_t max_buf_sz,
    size_t *out_sz);

const OSSL_PARAM *EVP_PKEY_settable_params(const EVP_PKEY *pkey);
int EVP_PKEY_set_params(EVP_PKEY *pkey, OSSL_PARAM params[]);
int EVP_PKEY_set_int_param(EVP_PKEY *pkey, const char *key_name, int in);
int EVP_PKEY_set_size_t_param(EVP_PKEY *pkey, const char *key_name, size_t in);
int EVP_PKEY_set_bn_param(EVP_PKEY *pkey, const char *key_name,
    const BIGNUM *bn);
int EVP_PKEY_set_utf8_string_param(EVP_PKEY *pkey, const char *key_name,
    const char *str);
int EVP_PKEY_set_octet_string_param(EVP_PKEY *pkey, const char *key_name,
    const unsigned char *buf, size_t bsize);

int EVP_PKEY_get_ec_point_conv_form(const EVP_PKEY *pkey);
int EVP_PKEY_get_field_type(const EVP_PKEY *pkey);

EVP_PKEY *EVP_PKEY_Q_keygen(OSSL_LIB_CTX *libctx, const char *propq,
    const char *type, ...);
int EVP_PKEY_paramgen_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_paramgen(EVP_PKEY_CTX *ctx, EVP_PKEY **ppkey);
int EVP_PKEY_keygen_init(EVP_PKEY_CTX *ctx);
int EVP_PKEY_keygen(EVP_PKEY_CTX *ctx, EVP_PKEY **ppkey);
int EVP_PKEY_generate(EVP_PKEY_CTX *ctx, EVP_PKEY **ppkey);
int EVP_PKEY_check(EVP_PKEY_CTX *ctx);
int EVP_PKEY_public_check(EVP_PKEY_CTX *ctx);
int EVP_PKEY_public_check_quick(EVP_PKEY_CTX *ctx);
int EVP_PKEY_param_check(EVP_PKEY_CTX *ctx);
int EVP_PKEY_param_check_quick(EVP_PKEY_CTX *ctx);
int EVP_PKEY_private_check(EVP_PKEY_CTX *ctx);
int EVP_PKEY_pairwise_check(EVP_PKEY_CTX *ctx);

#define EVP_PKEY_get_ex_new_index(l, p, newf, dupf, freef) \
    CRYPTO_get_ex_new_index(CRYPTO_EX_INDEX_EVP_PKEY, l, p, newf, dupf, freef)
int EVP_PKEY_set_ex_data(EVP_PKEY *key, int idx, void *arg);
void *EVP_PKEY_get_ex_data(const EVP_PKEY *key, int idx);

void EVP_PKEY_CTX_set_cb(EVP_PKEY_CTX *ctx, EVP_PKEY_gen_cb *cb);
EVP_PKEY_gen_cb *EVP_PKEY_CTX_get_cb(EVP_PKEY_CTX *ctx);

int EVP_PKEY_CTX_get_keygen_info(EVP_PKEY_CTX *ctx, int idx);
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_init(EVP_PKEY_METHOD *pmeth,
    int (*init)(EVP_PKEY_CTX *ctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_copy(EVP_PKEY_METHOD *pmeth, int (*copy)(EVP_PKEY_CTX *dst, const EVP_PKEY_CTX *src));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_cleanup(EVP_PKEY_METHOD *pmeth, void (*cleanup)(EVP_PKEY_CTX *ctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_paramgen(EVP_PKEY_METHOD *pmeth, int (*paramgen_init)(EVP_PKEY_CTX *ctx),
    int (*paramgen)(EVP_PKEY_CTX *ctx, EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_keygen(EVP_PKEY_METHOD *pmeth, int (*keygen_init)(EVP_PKEY_CTX *ctx),
    int (*keygen)(EVP_PKEY_CTX *ctx, EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_sign(EVP_PKEY_METHOD *pmeth, int (*sign_init)(EVP_PKEY_CTX *ctx),
    int (*sign)(EVP_PKEY_CTX *ctx, unsigned char *sig, size_t *siglen,
        const unsigned char *tbs, size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_verify(EVP_PKEY_METHOD *pmeth, int (*verify_init)(EVP_PKEY_CTX *ctx),
    int (*verify)(EVP_PKEY_CTX *ctx, const unsigned char *sig, size_t siglen,
        const unsigned char *tbs, size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_verify_recover(EVP_PKEY_METHOD *pmeth, int (*verify_recover_init)(EVP_PKEY_CTX *ctx),
    int (*verify_recover)(EVP_PKEY_CTX *ctx, unsigned char *sig,
        size_t *siglen, const unsigned char *tbs,
        size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_signctx(EVP_PKEY_METHOD *pmeth, int (*signctx_init)(EVP_PKEY_CTX *ctx, EVP_MD_CTX *mctx),
    int (*signctx)(EVP_PKEY_CTX *ctx, unsigned char *sig, size_t *siglen,
        EVP_MD_CTX *mctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_verifyctx(EVP_PKEY_METHOD *pmeth, int (*verifyctx_init)(EVP_PKEY_CTX *ctx, EVP_MD_CTX *mctx),
    int (*verifyctx)(EVP_PKEY_CTX *ctx, const unsigned char *sig, int siglen,
        EVP_MD_CTX *mctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_encrypt(EVP_PKEY_METHOD *pmeth, int (*encrypt_init)(EVP_PKEY_CTX *ctx),
    int (*encryptfn)(EVP_PKEY_CTX *ctx, unsigned char *out, size_t *outlen,
        const unsigned char *in, size_t inlen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_decrypt(EVP_PKEY_METHOD *pmeth, int (*decrypt_init)(EVP_PKEY_CTX *ctx),
    int (*decrypt)(EVP_PKEY_CTX *ctx, unsigned char *out, size_t *outlen,
        const unsigned char *in, size_t inlen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_derive(EVP_PKEY_METHOD *pmeth, int (*derive_init)(EVP_PKEY_CTX *ctx),
    int (*derive)(EVP_PKEY_CTX *ctx, unsigned char *key, size_t *keylen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_ctrl(EVP_PKEY_METHOD *pmeth, int (*ctrl)(EVP_PKEY_CTX *ctx, int type, int p1, void *p2),
    int (*ctrl_str)(EVP_PKEY_CTX *ctx, const char *type, const char *value));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_digestsign(EVP_PKEY_METHOD *pmeth,
    int (*digestsign)(EVP_MD_CTX *ctx, unsigned char *sig, size_t *siglen,
        const unsigned char *tbs, size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_digestverify(EVP_PKEY_METHOD *pmeth,
    int (*digestverify)(EVP_MD_CTX *ctx, const unsigned char *sig,
        size_t siglen, const unsigned char *tbs,
        size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_check(EVP_PKEY_METHOD *pmeth, int (*check)(EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_public_check(EVP_PKEY_METHOD *pmeth, int (*check)(EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_param_check(EVP_PKEY_METHOD *pmeth, int (*check)(EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_set_digest_custom(EVP_PKEY_METHOD *pmeth, int (*digest_custom)(EVP_PKEY_CTX *ctx, EVP_MD_CTX *mctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_init(const EVP_PKEY_METHOD *pmeth, int (**pinit)(EVP_PKEY_CTX *ctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_copy(const EVP_PKEY_METHOD *pmeth, int (**pcopy)(EVP_PKEY_CTX *dst, const EVP_PKEY_CTX *src));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_cleanup(const EVP_PKEY_METHOD *pmeth, void (**pcleanup)(EVP_PKEY_CTX *ctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_paramgen(const EVP_PKEY_METHOD *pmeth, int (**pparamgen_init)(EVP_PKEY_CTX *ctx),
    int (**pparamgen)(EVP_PKEY_CTX *ctx, EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_keygen(const EVP_PKEY_METHOD *pmeth, int (**pkeygen_init)(EVP_PKEY_CTX *ctx),
    int (**pkeygen)(EVP_PKEY_CTX *ctx, EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_sign(const EVP_PKEY_METHOD *pmeth, int (**psign_init)(EVP_PKEY_CTX *ctx),
    int (**psign)(EVP_PKEY_CTX *ctx, unsigned char *sig, size_t *siglen,
        const unsigned char *tbs, size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_verify(const EVP_PKEY_METHOD *pmeth, int (**pverify_init)(EVP_PKEY_CTX *ctx),
    int (**pverify)(EVP_PKEY_CTX *ctx, const unsigned char *sig,
        size_t siglen, const unsigned char *tbs, size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_verify_recover(const EVP_PKEY_METHOD *pmeth,
    int (**pverify_recover_init)(EVP_PKEY_CTX *ctx),
    int (**pverify_recover)(EVP_PKEY_CTX *ctx, unsigned char *sig,
        size_t *siglen, const unsigned char *tbs,
        size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_signctx(const EVP_PKEY_METHOD *pmeth,
    int (**psignctx_init)(EVP_PKEY_CTX *ctx, EVP_MD_CTX *mctx),
    int (**psignctx)(EVP_PKEY_CTX *ctx, unsigned char *sig, size_t *siglen,
        EVP_MD_CTX *mctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_verifyctx(const EVP_PKEY_METHOD *pmeth,
    int (**pverifyctx_init)(EVP_PKEY_CTX *ctx, EVP_MD_CTX *mctx),
    int (**pverifyctx)(EVP_PKEY_CTX *ctx, const unsigned char *sig,
        int siglen, EVP_MD_CTX *mctx));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_encrypt(const EVP_PKEY_METHOD *pmeth, int (**pencrypt_init)(EVP_PKEY_CTX *ctx),
    int (**pencryptfn)(EVP_PKEY_CTX *ctx, unsigned char *out, size_t *outlen,
        const unsigned char *in, size_t inlen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_decrypt(const EVP_PKEY_METHOD *pmeth, int (**pdecrypt_init)(EVP_PKEY_CTX *ctx),
    int (**pdecrypt)(EVP_PKEY_CTX *ctx, unsigned char *out, size_t *outlen,
        const unsigned char *in, size_t inlen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_derive(const EVP_PKEY_METHOD *pmeth, int (**pderive_init)(EVP_PKEY_CTX *ctx),
    int (**pderive)(EVP_PKEY_CTX *ctx, unsigned char *key, size_t *keylen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_ctrl(const EVP_PKEY_METHOD *pmeth,
    int (**pctrl)(EVP_PKEY_CTX *ctx, int type, int p1, void *p2),
    int (**pctrl_str)(EVP_PKEY_CTX *ctx, const char *type,
        const char *value));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_digestsign(const EVP_PKEY_METHOD *pmeth,
    int (**digestsign)(EVP_MD_CTX *ctx, unsigned char *sig, size_t *siglen,
        const unsigned char *tbs, size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_digestverify(const EVP_PKEY_METHOD *pmeth,
    int (**digestverify)(EVP_MD_CTX *ctx, const unsigned char *sig,
        size_t siglen, const unsigned char *tbs,
        size_t tbslen));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_check(const EVP_PKEY_METHOD *pmeth, int (**pcheck)(EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_public_check(const EVP_PKEY_METHOD *pmeth, int (**pcheck)(EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_param_check(const EVP_PKEY_METHOD *pmeth, int (**pcheck)(EVP_PKEY *pkey));
OSSL_DEPRECATEDIN_3_0 void EVP_PKEY_meth_get_digest_custom(const EVP_PKEY_METHOD *pmeth,
    int (**pdigest_custom)(EVP_PKEY_CTX *ctx, EVP_MD_CTX *mctx));
#endif

void EVP_KEYEXCH_free(EVP_KEYEXCH *exchange);
int EVP_KEYEXCH_up_ref(EVP_KEYEXCH *exchange);
EVP_KEYEXCH *EVP_KEYEXCH_fetch(OSSL_LIB_CTX *ctx, const char *algorithm,
    const char *properties);
OSSL_PROVIDER *EVP_KEYEXCH_get0_provider(const EVP_KEYEXCH *exchange);
int EVP_KEYEXCH_is_a(const EVP_KEYEXCH *keyexch, const char *name);
const char *EVP_KEYEXCH_get0_name(const EVP_KEYEXCH *keyexch);
const char *EVP_KEYEXCH_get0_description(const EVP_KEYEXCH *keyexch);
void EVP_KEYEXCH_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_KEYEXCH *keyexch, void *data),
    void *data);
int EVP_KEYEXCH_names_do_all(const EVP_KEYEXCH *keyexch,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PARAM *EVP_KEYEXCH_gettable_ctx_params(const EVP_KEYEXCH *keyexch);
const OSSL_PARAM *EVP_KEYEXCH_settable_ctx_params(const EVP_KEYEXCH *keyexch);

void EVP_add_alg_module(void);

int EVP_PKEY_CTX_set_group_name(EVP_PKEY_CTX *ctx, const char *name);
int EVP_PKEY_CTX_get_group_name(EVP_PKEY_CTX *ctx, char *name, size_t namelen);
int EVP_PKEY_get_group_name(const EVP_PKEY *pkey, char *name, size_t name_sz,
    size_t *gname_len);

OSSL_LIB_CTX *EVP_PKEY_CTX_get0_libctx(EVP_PKEY_CTX *ctx);
const char *EVP_PKEY_CTX_get0_propq(const EVP_PKEY_CTX *ctx);
const OSSL_PROVIDER *EVP_PKEY_CTX_get0_provider(const EVP_PKEY_CTX *ctx);

int EVP_SKEY_is_a(const EVP_SKEY *skey, const char *name);
EVP_SKEY *EVP_SKEY_import(OSSL_LIB_CTX *libctx, const char *skeymgmtname, const char *propquery,
    int selection, const OSSL_PARAM *params);
EVP_SKEY *EVP_SKEY_generate(OSSL_LIB_CTX *libctx, const char *skeymgmtname,
    const char *propquery, const OSSL_PARAM *params);
EVP_SKEY *EVP_SKEY_import_raw_key(OSSL_LIB_CTX *libctx, const char *skeymgmtname,
    unsigned char *key, size_t keylen,
    const char *propquery);
EVP_SKEY *EVP_SKEY_import_SKEYMGMT(OSSL_LIB_CTX *libctx, EVP_SKEYMGMT *skeymgmt,
    int selection, const OSSL_PARAM *params);
int EVP_SKEY_get0_raw_key(const EVP_SKEY *skey, const unsigned char **key,
    size_t *len);
const char *EVP_SKEY_get0_key_id(const EVP_SKEY *skey);
int EVP_SKEY_export(const EVP_SKEY *skey, int selection,
    OSSL_CALLBACK *export_cb, void *export_cbarg);
int EVP_SKEY_up_ref(EVP_SKEY *skey);
void EVP_SKEY_free(EVP_SKEY *skey);
const char *EVP_SKEY_get0_skeymgmt_name(const EVP_SKEY *skey);
const char *EVP_SKEY_get0_provider_name(const EVP_SKEY *skey);
EVP_SKEY *EVP_SKEY_to_provider(EVP_SKEY *skey, OSSL_LIB_CTX *libctx,
    OSSL_PROVIDER *prov, const char *propquery);

#ifdef __cplusplus
}
#endif
#endif
