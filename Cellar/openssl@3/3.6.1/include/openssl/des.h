/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_DES_H
#define OPENSSL_DES_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_DES_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_DES
#ifdef __cplusplus
extern "C" {
#endif
#include <openssl/e_os2.h>

#ifndef OPENSSL_NO_DEPRECATED_3_0
typedef unsigned int DES_LONG;

#ifdef OPENSSL_BUILD_SHLIBCRYPTO
#undef OPENSSL_EXTERN
#define OPENSSL_EXTERN OPENSSL_EXPORT
#endif

typedef unsigned char DES_cblock[8];
typedef /* const */ unsigned char const_DES_cblock[8];
/*
 * With "const", gcc 2.8.1 on Solaris thinks that DES_cblock * and
 * const_DES_cblock * are incompatible pointer types.
 */

typedef struct DES_ks {
    union {
        DES_cblock cblock;
        /*
         * make sure things are correct size on machines with 8 byte longs
         */
        DES_LONG deslong[2];
    } ks[16];
} DES_key_schedule;

#define DES_KEY_SZ (sizeof(DES_cblock))
#define DES_SCHEDULE_SZ (sizeof(DES_key_schedule))

#define DES_ENCRYPT 1
#define DES_DECRYPT 0

#define DES_CBC_MODE 0
#define DES_PCBC_MODE 1

#define DES_ecb2_encrypt(i, o, k1, k2, e) \
    DES_ecb3_encrypt((i), (o), (k1), (k2), (k1), (e))

#define DES_ede2_cbc_encrypt(i, o, l, k1, k2, iv, e) \
    DES_ede3_cbc_encrypt((i), (o), (l), (k1), (k2), (k1), (iv), (e))

#define DES_ede2_cfb64_encrypt(i, o, l, k1, k2, iv, n, e) \
    DES_ede3_cfb64_encrypt((i), (o), (l), (k1), (k2), (k1), (iv), (n), (e))

#define DES_ede2_ofb64_encrypt(i, o, l, k1, k2, iv, n) \
    DES_ede3_ofb64_encrypt((i), (o), (l), (k1), (k2), (k1), (iv), (n))

#define DES_fixup_key_parity DES_set_odd_parity
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 const char *DES_options(void);
OSSL_DEPRECATEDIN_3_0
void DES_ecb3_encrypt(const_DES_cblock *input, DES_cblock *output,
    DES_key_schedule *ks1, DES_key_schedule *ks2,
    DES_key_schedule *ks3, int enc);
OSSL_DEPRECATEDIN_3_0
DES_LONG DES_cbc_cksum(const unsigned char *input, DES_cblock *output,
    long length, DES_key_schedule *schedule,
    const_DES_cblock *ivec);
#endif
/* DES_cbc_encrypt does not update the IV!  Use DES_ncbc_encrypt instead. */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
void DES_cbc_encrypt(const unsigned char *input, unsigned char *output,
    long length, DES_key_schedule *schedule, DES_cblock *ivec,
    int enc);
OSSL_DEPRECATEDIN_3_0
void DES_ncbc_encrypt(const unsigned char *input, unsigned char *output,
    long length, DES_key_schedule *schedule, DES_cblock *ivec,
    int enc);
OSSL_DEPRECATEDIN_3_0
void DES_xcbc_encrypt(const unsigned char *input, unsigned char *output,
    long length, DES_key_schedule *schedule, DES_cblock *ivec,
    const_DES_cblock *inw, const_DES_cblock *outw, int enc);
OSSL_DEPRECATEDIN_3_0
void DES_cfb_encrypt(const unsigned char *in, unsigned char *out, int numbits,
    long length, DES_key_schedule *schedule, DES_cblock *ivec,
    int enc);
OSSL_DEPRECATEDIN_3_0
void DES_ecb_encrypt(const_DES_cblock *input, DES_cblock *output,
    DES_key_schedule *ks, int enc);
#endif

/*
 * This is the DES encryption function that gets called by just about every
 * other DES routine in the library.  You should not use this function except
 * to implement 'modes' of DES.  I say this because the functions that call
 * this routine do the conversion from 'char *' to long, and this needs to be
 * done to make sure 'non-aligned' memory access do not occur.  The
 * characters are loaded 'little endian'. Data is a pointer to 2 unsigned
 * long's and ks is the DES_key_schedule to use.  enc, is non zero specifies
 * encryption, zero if decryption.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
void DES_encrypt1(DES_LONG *data, DES_key_schedule *ks, int enc);
#endif

/*
 * This functions is the same as DES_encrypt1() except that the DES initial
 * permutation (IP) and final permutation (FP) have been left out.  As for
 * DES_encrypt1(), you should not use this function. It is used by the
 * routines in the library that implement triple DES. IP() DES_encrypt2()
 * DES_encrypt2() DES_encrypt2() FP() is the same as DES_encrypt1()
 * DES_encrypt1() DES_encrypt1() except faster :-).
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
void DES_encrypt2(DES_LONG *data, DES_key_schedule *ks, int enc);
OSSL_DEPRECATEDIN_3_0
void DES_encrypt3(DES_LONG *data, DES_key_schedule *ks1, DES_key_schedule *ks2,
    DES_key_schedule *ks3);
OSSL_DEPRECATEDIN_3_0
void DES_decrypt3(DES_LONG *data, DES_key_schedule *ks1, DES_key_schedule *ks2,
    DES_key_schedule *ks3);
OSSL_DEPRECATEDIN_3_0
void DES_ede3_cbc_encrypt(const unsigned char *input, unsigned char *output,
    long length, DES_key_schedule *ks1,
    DES_key_schedule *ks2, DES_key_schedule *ks3,
    DES_cblock *ivec, int enc);
OSSL_DEPRECATEDIN_3_0
void DES_ede3_cfb64_encrypt(const unsigned char *in, unsigned char *out,
    long length, DES_key_schedule *ks1,
    DES_key_schedule *ks2, DES_key_schedule *ks3,
    DES_cblock *ivec, int *num, int enc);
OSSL_DEPRECATEDIN_3_0
void DES_ede3_cfb_encrypt(const unsigned char *in, unsigned char *out,
    int numbits, long length, DES_key_schedule *ks1,
    DES_key_schedule *ks2, DES_key_schedule *ks3,
    DES_cblock *ivec, int enc);
OSSL_DEPRECATEDIN_3_0
void DES_ede3_ofb64_encrypt(const unsigned char *in, unsigned char *out,
    long length, DES_key_schedule *ks1,
    DES_key_schedule *ks2, DES_key_schedule *ks3,
    DES_cblock *ivec, int *num);
OSSL_DEPRECATEDIN_3_0
char *DES_fcrypt(const char *buf, const char *salt, char *ret);
OSSL_DEPRECATEDIN_3_0
char *DES_crypt(const char *buf, const char *salt);
OSSL_DEPRECATEDIN_3_0
void DES_ofb_encrypt(const unsigned char *in, unsigned char *out, int numbits,
    long length, DES_key_schedule *schedule, DES_cblock *ivec);
OSSL_DEPRECATEDIN_3_0
void DES_pcbc_encrypt(const unsigned char *input, unsigned char *output,
    long length, DES_key_schedule *schedule,
    DES_cblock *ivec, int enc);
OSSL_DEPRECATEDIN_3_0
DES_LONG DES_quad_cksum(const unsigned char *input, DES_cblock output[],
    long length, int out_count, DES_cblock *seed);
OSSL_DEPRECATEDIN_3_0 int DES_random_key(DES_cblock *ret);
OSSL_DEPRECATEDIN_3_0 void DES_set_odd_parity(DES_cblock *key);
OSSL_DEPRECATEDIN_3_0 int DES_check_key_parity(const_DES_cblock *key);
OSSL_DEPRECATEDIN_3_0 int DES_is_weak_key(const_DES_cblock *key);
#endif
/*
 * DES_set_key (= set_key = DES_key_sched = key_sched) calls
 * DES_set_key_checked
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
int DES_set_key(const_DES_cblock *key, DES_key_schedule *schedule);
OSSL_DEPRECATEDIN_3_0
int DES_key_sched(const_DES_cblock *key, DES_key_schedule *schedule);
OSSL_DEPRECATEDIN_3_0
int DES_set_key_checked(const_DES_cblock *key, DES_key_schedule *schedule);
OSSL_DEPRECATEDIN_3_0
void DES_set_key_unchecked(const_DES_cblock *key, DES_key_schedule *schedule);
OSSL_DEPRECATEDIN_3_0 void DES_string_to_key(const char *str, DES_cblock *key);
OSSL_DEPRECATEDIN_3_0
void DES_string_to_2keys(const char *str, DES_cblock *key1, DES_cblock *key2);
OSSL_DEPRECATEDIN_3_0
void DES_cfb64_encrypt(const unsigned char *in, unsigned char *out,
    long length, DES_key_schedule *schedule,
    DES_cblock *ivec, int *num, int enc);
OSSL_DEPRECATEDIN_3_0
void DES_ofb64_encrypt(const unsigned char *in, unsigned char *out,
    long length, DES_key_schedule *schedule,
    DES_cblock *ivec, int *num);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
