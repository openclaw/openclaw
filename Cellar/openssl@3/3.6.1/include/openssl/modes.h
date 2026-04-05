/*
 * Copyright 2008-2016 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_MODES_H
#define OPENSSL_MODES_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_MODES_H
#endif

#include <stddef.h>
#include <openssl/types.h>

#ifdef __cplusplus
extern "C" {
#endif
typedef void (*block128_f)(const unsigned char in[16],
    unsigned char out[16], const void *key);

typedef void (*cbc128_f)(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], int enc);

typedef void (*ecb128_f)(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    int enc);

typedef void (*ctr128_f)(const unsigned char *in, unsigned char *out,
    size_t blocks, const void *key,
    const unsigned char ivec[16]);

typedef void (*ccm128_f)(const unsigned char *in, unsigned char *out,
    size_t blocks, const void *key,
    const unsigned char ivec[16],
    unsigned char cmac[16]);

void CRYPTO_cbc128_encrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], block128_f block);
void CRYPTO_cbc128_decrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], block128_f block);

void CRYPTO_ctr128_encrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16],
    unsigned char ecount_buf[16], unsigned int *num,
    block128_f block);

void CRYPTO_ctr128_encrypt_ctr32(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16],
    unsigned char ecount_buf[16],
    unsigned int *num, ctr128_f ctr);

void CRYPTO_ofb128_encrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], int *num,
    block128_f block);

void CRYPTO_cfb128_encrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], int *num,
    int enc, block128_f block);
void CRYPTO_cfb128_8_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const void *key,
    unsigned char ivec[16], int *num,
    int enc, block128_f block);
void CRYPTO_cfb128_1_encrypt(const unsigned char *in, unsigned char *out,
    size_t bits, const void *key,
    unsigned char ivec[16], int *num,
    int enc, block128_f block);

size_t CRYPTO_cts128_encrypt_block(const unsigned char *in,
    unsigned char *out, size_t len,
    const void *key, unsigned char ivec[16],
    block128_f block);
size_t CRYPTO_cts128_encrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], cbc128_f cbc);
size_t CRYPTO_cts128_decrypt_block(const unsigned char *in,
    unsigned char *out, size_t len,
    const void *key, unsigned char ivec[16],
    block128_f block);
size_t CRYPTO_cts128_decrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], cbc128_f cbc);

size_t CRYPTO_nistcts128_encrypt_block(const unsigned char *in,
    unsigned char *out, size_t len,
    const void *key,
    unsigned char ivec[16],
    block128_f block);
size_t CRYPTO_nistcts128_encrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], cbc128_f cbc);
size_t CRYPTO_nistcts128_decrypt_block(const unsigned char *in,
    unsigned char *out, size_t len,
    const void *key,
    unsigned char ivec[16],
    block128_f block);
size_t CRYPTO_nistcts128_decrypt(const unsigned char *in, unsigned char *out,
    size_t len, const void *key,
    unsigned char ivec[16], cbc128_f cbc);

typedef struct gcm128_context GCM128_CONTEXT;

GCM128_CONTEXT *CRYPTO_gcm128_new(void *key, block128_f block);
void CRYPTO_gcm128_init(GCM128_CONTEXT *ctx, void *key, block128_f block);
void CRYPTO_gcm128_setiv(GCM128_CONTEXT *ctx, const unsigned char *iv,
    size_t len);
int CRYPTO_gcm128_aad(GCM128_CONTEXT *ctx, const unsigned char *aad,
    size_t len);
int CRYPTO_gcm128_encrypt(GCM128_CONTEXT *ctx,
    const unsigned char *in, unsigned char *out,
    size_t len);
int CRYPTO_gcm128_decrypt(GCM128_CONTEXT *ctx,
    const unsigned char *in, unsigned char *out,
    size_t len);
int CRYPTO_gcm128_encrypt_ctr32(GCM128_CONTEXT *ctx,
    const unsigned char *in, unsigned char *out,
    size_t len, ctr128_f stream);
int CRYPTO_gcm128_decrypt_ctr32(GCM128_CONTEXT *ctx,
    const unsigned char *in, unsigned char *out,
    size_t len, ctr128_f stream);
int CRYPTO_gcm128_finish(GCM128_CONTEXT *ctx, const unsigned char *tag,
    size_t len);
void CRYPTO_gcm128_tag(GCM128_CONTEXT *ctx, unsigned char *tag, size_t len);
void CRYPTO_gcm128_release(GCM128_CONTEXT *ctx);

typedef struct ccm128_context CCM128_CONTEXT;

void CRYPTO_ccm128_init(CCM128_CONTEXT *ctx,
    unsigned int M, unsigned int L, void *key,
    block128_f block);
int CRYPTO_ccm128_setiv(CCM128_CONTEXT *ctx, const unsigned char *nonce,
    size_t nlen, size_t mlen);
void CRYPTO_ccm128_aad(CCM128_CONTEXT *ctx, const unsigned char *aad,
    size_t alen);
int CRYPTO_ccm128_encrypt(CCM128_CONTEXT *ctx, const unsigned char *inp,
    unsigned char *out, size_t len);
int CRYPTO_ccm128_decrypt(CCM128_CONTEXT *ctx, const unsigned char *inp,
    unsigned char *out, size_t len);
int CRYPTO_ccm128_encrypt_ccm64(CCM128_CONTEXT *ctx, const unsigned char *inp,
    unsigned char *out, size_t len,
    ccm128_f stream);
int CRYPTO_ccm128_decrypt_ccm64(CCM128_CONTEXT *ctx, const unsigned char *inp,
    unsigned char *out, size_t len,
    ccm128_f stream);
size_t CRYPTO_ccm128_tag(CCM128_CONTEXT *ctx, unsigned char *tag, size_t len);

typedef struct xts128_context XTS128_CONTEXT;

int CRYPTO_xts128_encrypt(const XTS128_CONTEXT *ctx,
    const unsigned char iv[16],
    const unsigned char *inp, unsigned char *out,
    size_t len, int enc);

size_t CRYPTO_128_wrap(void *key, const unsigned char *iv,
    unsigned char *out,
    const unsigned char *in, size_t inlen,
    block128_f block);

size_t CRYPTO_128_unwrap(void *key, const unsigned char *iv,
    unsigned char *out,
    const unsigned char *in, size_t inlen,
    block128_f block);
size_t CRYPTO_128_wrap_pad(void *key, const unsigned char *icv,
    unsigned char *out, const unsigned char *in,
    size_t inlen, block128_f block);
size_t CRYPTO_128_unwrap_pad(void *key, const unsigned char *icv,
    unsigned char *out, const unsigned char *in,
    size_t inlen, block128_f block);

#ifndef OPENSSL_NO_OCB
typedef struct ocb128_context OCB128_CONTEXT;

typedef void (*ocb128_f)(const unsigned char *in, unsigned char *out,
    size_t blocks, const void *key,
    size_t start_block_num,
    unsigned char offset_i[16],
    const unsigned char L_[][16],
    unsigned char checksum[16]);

OCB128_CONTEXT *CRYPTO_ocb128_new(void *keyenc, void *keydec,
    block128_f encrypt, block128_f decrypt,
    ocb128_f stream);
int CRYPTO_ocb128_init(OCB128_CONTEXT *ctx, void *keyenc, void *keydec,
    block128_f encrypt, block128_f decrypt,
    ocb128_f stream);
int CRYPTO_ocb128_copy_ctx(OCB128_CONTEXT *dest, OCB128_CONTEXT *src,
    void *keyenc, void *keydec);
int CRYPTO_ocb128_setiv(OCB128_CONTEXT *ctx, const unsigned char *iv,
    size_t len, size_t taglen);
int CRYPTO_ocb128_aad(OCB128_CONTEXT *ctx, const unsigned char *aad,
    size_t len);
int CRYPTO_ocb128_encrypt(OCB128_CONTEXT *ctx, const unsigned char *in,
    unsigned char *out, size_t len);
int CRYPTO_ocb128_decrypt(OCB128_CONTEXT *ctx, const unsigned char *in,
    unsigned char *out, size_t len);
int CRYPTO_ocb128_finish(OCB128_CONTEXT *ctx, const unsigned char *tag,
    size_t len);
int CRYPTO_ocb128_tag(OCB128_CONTEXT *ctx, unsigned char *tag, size_t len);
void CRYPTO_ocb128_cleanup(OCB128_CONTEXT *ctx);
#endif /* OPENSSL_NO_OCB */

#ifdef __cplusplus
}
#endif

#endif
