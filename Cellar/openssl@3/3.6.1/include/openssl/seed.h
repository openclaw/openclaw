/*
 * Copyright 2007-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

/*
 * Copyright (c) 2007 KISA(Korea Information Security Agency). All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Neither the name of author nor the names of its contributors may
 *    be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY AUTHOR AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL AUTHOR OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 */

#ifndef OPENSSL_SEED_H
#define OPENSSL_SEED_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_SEED_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_SEED
#include <openssl/e_os2.h>
#include <openssl/crypto.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SEED_BLOCK_SIZE 16
#define SEED_KEY_LENGTH 16

#ifndef OPENSSL_NO_DEPRECATED_3_0
/* look whether we need 'long' to get 32 bits */
#ifdef AES_LONG
#ifndef SEED_LONG
#define SEED_LONG 1
#endif
#endif

typedef struct seed_key_st {
#ifdef SEED_LONG
    unsigned long data[32];
#else
    unsigned int data[32];
#endif
} SEED_KEY_SCHEDULE;
#endif /* OPENSSL_NO_DEPRECATED_3_0 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
void SEED_set_key(const unsigned char rawkey[SEED_KEY_LENGTH],
    SEED_KEY_SCHEDULE *ks);
OSSL_DEPRECATEDIN_3_0
void SEED_encrypt(const unsigned char s[SEED_BLOCK_SIZE],
    unsigned char d[SEED_BLOCK_SIZE],
    const SEED_KEY_SCHEDULE *ks);
OSSL_DEPRECATEDIN_3_0
void SEED_decrypt(const unsigned char s[SEED_BLOCK_SIZE],
    unsigned char d[SEED_BLOCK_SIZE],
    const SEED_KEY_SCHEDULE *ks);
OSSL_DEPRECATEDIN_3_0
void SEED_ecb_encrypt(const unsigned char *in,
    unsigned char *out,
    const SEED_KEY_SCHEDULE *ks, int enc);
OSSL_DEPRECATEDIN_3_0
void SEED_cbc_encrypt(const unsigned char *in, unsigned char *out, size_t len,
    const SEED_KEY_SCHEDULE *ks,
    unsigned char ivec[SEED_BLOCK_SIZE],
    int enc);
OSSL_DEPRECATEDIN_3_0
void SEED_cfb128_encrypt(const unsigned char *in, unsigned char *out,
    size_t len, const SEED_KEY_SCHEDULE *ks,
    unsigned char ivec[SEED_BLOCK_SIZE],
    int *num, int enc);
OSSL_DEPRECATEDIN_3_0
void SEED_ofb128_encrypt(const unsigned char *in, unsigned char *out,
    size_t len, const SEED_KEY_SCHEDULE *ks,
    unsigned char ivec[SEED_BLOCK_SIZE],
    int *num);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
