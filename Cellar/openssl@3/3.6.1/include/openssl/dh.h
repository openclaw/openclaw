/*
 * Copyright 1995-2023 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_DH_H
#define OPENSSL_DH_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_DH_H
#endif

#include <openssl/opensslconf.h>
#include <openssl/types.h>

#ifdef __cplusplus
extern "C" {
#endif

#include <stdlib.h>

/*
 * DH parameter generation types used by EVP_PKEY_CTX_set_dh_paramgen_type()
 * Note that additions/changes to this set of values requires corresponding
 * adjustments to range checks in dh_gen()
 */
#define DH_PARAMGEN_TYPE_GENERATOR 0 /* Use a safe prime generator */
#define DH_PARAMGEN_TYPE_FIPS_186_2 1 /* Use FIPS186-2 standard */
#define DH_PARAMGEN_TYPE_FIPS_186_4 2 /* Use FIPS186-4 standard */
#define DH_PARAMGEN_TYPE_GROUP 3 /* Use a named safe prime group */

int EVP_PKEY_CTX_set_dh_paramgen_type(EVP_PKEY_CTX *ctx, int typ);
int EVP_PKEY_CTX_set_dh_paramgen_gindex(EVP_PKEY_CTX *ctx, int gindex);
int EVP_PKEY_CTX_set_dh_paramgen_seed(EVP_PKEY_CTX *ctx,
    const unsigned char *seed,
    size_t seedlen);
int EVP_PKEY_CTX_set_dh_paramgen_prime_len(EVP_PKEY_CTX *ctx, int pbits);
int EVP_PKEY_CTX_set_dh_paramgen_subprime_len(EVP_PKEY_CTX *ctx, int qlen);
int EVP_PKEY_CTX_set_dh_paramgen_generator(EVP_PKEY_CTX *ctx, int gen);
int EVP_PKEY_CTX_set_dh_nid(EVP_PKEY_CTX *ctx, int nid);
int EVP_PKEY_CTX_set_dh_rfc5114(EVP_PKEY_CTX *ctx, int gen);
int EVP_PKEY_CTX_set_dhx_rfc5114(EVP_PKEY_CTX *ctx, int gen);
int EVP_PKEY_CTX_set_dh_pad(EVP_PKEY_CTX *ctx, int pad);

int EVP_PKEY_CTX_set_dh_kdf_type(EVP_PKEY_CTX *ctx, int kdf);
int EVP_PKEY_CTX_get_dh_kdf_type(EVP_PKEY_CTX *ctx);
int EVP_PKEY_CTX_set0_dh_kdf_oid(EVP_PKEY_CTX *ctx, ASN1_OBJECT *oid);
int EVP_PKEY_CTX_get0_dh_kdf_oid(EVP_PKEY_CTX *ctx, ASN1_OBJECT **oid);
int EVP_PKEY_CTX_set_dh_kdf_md(EVP_PKEY_CTX *ctx, const EVP_MD *md);
int EVP_PKEY_CTX_get_dh_kdf_md(EVP_PKEY_CTX *ctx, const EVP_MD **md);
int EVP_PKEY_CTX_set_dh_kdf_outlen(EVP_PKEY_CTX *ctx, int len);
int EVP_PKEY_CTX_get_dh_kdf_outlen(EVP_PKEY_CTX *ctx, int *len);
int EVP_PKEY_CTX_set0_dh_kdf_ukm(EVP_PKEY_CTX *ctx, unsigned char *ukm, int len);
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_CTX_get0_dh_kdf_ukm(EVP_PKEY_CTX *ctx, unsigned char **ukm);
#endif

#define EVP_PKEY_CTRL_DH_PARAMGEN_PRIME_LEN (EVP_PKEY_ALG_CTRL + 1)
#define EVP_PKEY_CTRL_DH_PARAMGEN_GENERATOR (EVP_PKEY_ALG_CTRL + 2)
#define EVP_PKEY_CTRL_DH_RFC5114 (EVP_PKEY_ALG_CTRL + 3)
#define EVP_PKEY_CTRL_DH_PARAMGEN_SUBPRIME_LEN (EVP_PKEY_ALG_CTRL + 4)
#define EVP_PKEY_CTRL_DH_PARAMGEN_TYPE (EVP_PKEY_ALG_CTRL + 5)
#define EVP_PKEY_CTRL_DH_KDF_TYPE (EVP_PKEY_ALG_CTRL + 6)
#define EVP_PKEY_CTRL_DH_KDF_MD (EVP_PKEY_ALG_CTRL + 7)
#define EVP_PKEY_CTRL_GET_DH_KDF_MD (EVP_PKEY_ALG_CTRL + 8)
#define EVP_PKEY_CTRL_DH_KDF_OUTLEN (EVP_PKEY_ALG_CTRL + 9)
#define EVP_PKEY_CTRL_GET_DH_KDF_OUTLEN (EVP_PKEY_ALG_CTRL + 10)
#define EVP_PKEY_CTRL_DH_KDF_UKM (EVP_PKEY_ALG_CTRL + 11)
#define EVP_PKEY_CTRL_GET_DH_KDF_UKM (EVP_PKEY_ALG_CTRL + 12)
#define EVP_PKEY_CTRL_DH_KDF_OID (EVP_PKEY_ALG_CTRL + 13)
#define EVP_PKEY_CTRL_GET_DH_KDF_OID (EVP_PKEY_ALG_CTRL + 14)
#define EVP_PKEY_CTRL_DH_NID (EVP_PKEY_ALG_CTRL + 15)
#define EVP_PKEY_CTRL_DH_PAD (EVP_PKEY_ALG_CTRL + 16)

/* KDF types */
#define EVP_PKEY_DH_KDF_NONE 1
#define EVP_PKEY_DH_KDF_X9_42 2

#ifndef OPENSSL_NO_STDIO
#include <stdio.h>
#endif
#ifndef OPENSSL_NO_DH
#include <openssl/e_os2.h>
#include <openssl/bio.h>
#include <openssl/asn1.h>
#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#include <openssl/bn.h>
#endif
#include <openssl/dherr.h>

#ifndef OPENSSL_DH_MAX_MODULUS_BITS
#define OPENSSL_DH_MAX_MODULUS_BITS 10000
#endif

#ifndef OPENSSL_DH_CHECK_MAX_MODULUS_BITS
#define OPENSSL_DH_CHECK_MAX_MODULUS_BITS 32768
#endif

#define OPENSSL_DH_FIPS_MIN_MODULUS_BITS 1024

#define DH_FLAG_CACHE_MONT_P 0x01

#define DH_FLAG_TYPE_MASK 0xF000
#define DH_FLAG_TYPE_DH 0x0000
#define DH_FLAG_TYPE_DHX 0x1000

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
/*
 * Does nothing. Previously this switched off constant time behaviour.
 */
#define DH_FLAG_NO_EXP_CONSTTIME 0x00
#endif

#ifndef OPENSSL_NO_DEPRECATED_3_0
/*
 * If this flag is set the DH method is FIPS compliant and can be used in
 * FIPS mode. This is set in the validated module method. If an application
 * sets this flag in its own methods it is its responsibility to ensure the
 * result is compliant.
 */

#define DH_FLAG_FIPS_METHOD 0x0400

/*
 * If this flag is set the operations normally disabled in FIPS mode are
 * permitted it is then the applications responsibility to ensure that the
 * usage is compliant.
 */

#define DH_FLAG_NON_FIPS_ALLOW 0x0400
#endif

/* Already defined in ossl_typ.h */
/* typedef struct dh_st DH; */
/* typedef struct dh_method DH_METHOD; */

DECLARE_ASN1_ITEM(DHparams)

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define DH_GENERATOR_2 2
#define DH_GENERATOR_3 3
#define DH_GENERATOR_5 5

/* DH_check error codes, some of them shared with DH_check_pub_key */
/*
 * NB: These values must align with the equivalently named macros in
 * internal/ffc.h.
 */
#define DH_CHECK_P_NOT_PRIME 0x01
#define DH_CHECK_P_NOT_SAFE_PRIME 0x02
#define DH_UNABLE_TO_CHECK_GENERATOR 0x04
#define DH_NOT_SUITABLE_GENERATOR 0x08
#define DH_CHECK_Q_NOT_PRIME 0x10
#define DH_CHECK_INVALID_Q_VALUE 0x20 /* +DH_check_pub_key */
#define DH_CHECK_INVALID_J_VALUE 0x40
#define DH_MODULUS_TOO_SMALL 0x80
#define DH_MODULUS_TOO_LARGE 0x100 /* +DH_check_pub_key */

/* DH_check_pub_key error codes */
#define DH_CHECK_PUBKEY_TOO_SMALL 0x01
#define DH_CHECK_PUBKEY_TOO_LARGE 0x02
#define DH_CHECK_PUBKEY_INVALID 0x04

/*
 * primes p where (p-1)/2 is prime too are called "safe"; we define this for
 * backward compatibility:
 */
#define DH_CHECK_P_NOT_STRONG_PRIME DH_CHECK_P_NOT_SAFE_PRIME

#define d2i_DHparams_fp(fp, x)                 \
    (DH *)ASN1_d2i_fp((void *(*)(void))DH_new, \
        (d2i_of_void *)d2i_DHparams,           \
        (fp),                                  \
        (void **)(x))
#define i2d_DHparams_fp(fp, x) \
    ASN1_i2d_fp(i2d_DHparams, (fp), (unsigned char *)(x))
#define d2i_DHparams_bio(bp, x) \
    ASN1_d2i_bio_of(DH, DH_new, d2i_DHparams, bp, x)
#define i2d_DHparams_bio(bp, x) \
    ASN1_i2d_bio_of(DH, i2d_DHparams, bp, x)

#define d2i_DHxparams_fp(fp, x)                \
    (DH *)ASN1_d2i_fp((void *(*)(void))DH_new, \
        (d2i_of_void *)d2i_DHxparams,          \
        (fp),                                  \
        (void **)(x))
#define i2d_DHxparams_fp(fp, x) \
    ASN1_i2d_fp(i2d_DHxparams, (fp), (unsigned char *)(x))
#define d2i_DHxparams_bio(bp, x) \
    ASN1_d2i_bio_of(DH, DH_new, d2i_DHxparams, bp, x)
#define i2d_DHxparams_bio(bp, x) \
    ASN1_i2d_bio_of(DH, i2d_DHxparams, bp, x)

DECLARE_ASN1_DUP_FUNCTION_name_attr(OSSL_DEPRECATEDIN_3_0, DH, DHparams)

OSSL_DEPRECATEDIN_3_0 const DH_METHOD *DH_OpenSSL(void);

OSSL_DEPRECATEDIN_3_0 void DH_set_default_method(const DH_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 const DH_METHOD *DH_get_default_method(void);
OSSL_DEPRECATEDIN_3_0 int DH_set_method(DH *dh, const DH_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 DH *DH_new_method(ENGINE *engine);

OSSL_DEPRECATEDIN_3_0 DH *DH_new(void);
OSSL_DEPRECATEDIN_3_0 void DH_free(DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_up_ref(DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_bits(const DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_size(const DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_security_bits(const DH *dh);

#define DH_get_ex_new_index(l, p, newf, dupf, freef) \
    CRYPTO_get_ex_new_index(CRYPTO_EX_INDEX_DH, l, p, newf, dupf, freef)

OSSL_DEPRECATEDIN_3_0 int DH_set_ex_data(DH *d, int idx, void *arg);
OSSL_DEPRECATEDIN_3_0 void *DH_get_ex_data(const DH *d, int idx);

OSSL_DEPRECATEDIN_3_0 int DH_generate_parameters_ex(DH *dh, int prime_len,
    int generator,
    BN_GENCB *cb);

OSSL_DEPRECATEDIN_3_0 int DH_check_params_ex(const DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_check_ex(const DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_check_pub_key_ex(const DH *dh, const BIGNUM *pub_key);
OSSL_DEPRECATEDIN_3_0 int DH_check_params(const DH *dh, int *ret);
OSSL_DEPRECATEDIN_3_0 int DH_check(const DH *dh, int *codes);
OSSL_DEPRECATEDIN_3_0 int DH_check_pub_key(const DH *dh, const BIGNUM *pub_key,
    int *codes);
OSSL_DEPRECATEDIN_3_0 int DH_generate_key(DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_compute_key(unsigned char *key,
    const BIGNUM *pub_key, DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_compute_key_padded(unsigned char *key,
    const BIGNUM *pub_key, DH *dh);

DECLARE_ASN1_ENCODE_FUNCTIONS_only_attr(OSSL_DEPRECATEDIN_3_0, DH, DHparams)
DECLARE_ASN1_ENCODE_FUNCTIONS_only_attr(OSSL_DEPRECATEDIN_3_0, DH, DHxparams)

#ifndef OPENSSL_NO_STDIO
OSSL_DEPRECATEDIN_3_0 int DHparams_print_fp(FILE *fp, const DH *x);
#endif
OSSL_DEPRECATEDIN_3_0 int DHparams_print(BIO *bp, const DH *x);

/* RFC 5114 parameters */
OSSL_DEPRECATEDIN_3_0 DH *DH_get_1024_160(void);
OSSL_DEPRECATEDIN_3_0 DH *DH_get_2048_224(void);
OSSL_DEPRECATEDIN_3_0 DH *DH_get_2048_256(void);

/* Named parameters, currently RFC7919 and RFC3526 */
OSSL_DEPRECATEDIN_3_0 DH *DH_new_by_nid(int nid);
OSSL_DEPRECATEDIN_3_0 int DH_get_nid(const DH *dh);

/* RFC2631 KDF */
OSSL_DEPRECATEDIN_3_0 int DH_KDF_X9_42(unsigned char *out, size_t outlen,
    const unsigned char *Z, size_t Zlen,
    ASN1_OBJECT *key_oid,
    const unsigned char *ukm,
    size_t ukmlen, const EVP_MD *md);

OSSL_DEPRECATEDIN_3_0 void DH_get0_pqg(const DH *dh, const BIGNUM **p,
    const BIGNUM **q, const BIGNUM **g);
OSSL_DEPRECATEDIN_3_0 int DH_set0_pqg(DH *dh, BIGNUM *p, BIGNUM *q, BIGNUM *g);
OSSL_DEPRECATEDIN_3_0 void DH_get0_key(const DH *dh, const BIGNUM **pub_key,
    const BIGNUM **priv_key);
OSSL_DEPRECATEDIN_3_0 int DH_set0_key(DH *dh, BIGNUM *pub_key, BIGNUM *priv_key);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *DH_get0_p(const DH *dh);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *DH_get0_q(const DH *dh);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *DH_get0_g(const DH *dh);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *DH_get0_priv_key(const DH *dh);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *DH_get0_pub_key(const DH *dh);
OSSL_DEPRECATEDIN_3_0 void DH_clear_flags(DH *dh, int flags);
OSSL_DEPRECATEDIN_3_0 int DH_test_flags(const DH *dh, int flags);
OSSL_DEPRECATEDIN_3_0 void DH_set_flags(DH *dh, int flags);
OSSL_DEPRECATEDIN_3_0 ENGINE *DH_get0_engine(DH *d);
OSSL_DEPRECATEDIN_3_0 long DH_get_length(const DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_set_length(DH *dh, long length);

OSSL_DEPRECATEDIN_3_0 DH_METHOD *DH_meth_new(const char *name, int flags);
OSSL_DEPRECATEDIN_3_0 void DH_meth_free(DH_METHOD *dhm);
OSSL_DEPRECATEDIN_3_0 DH_METHOD *DH_meth_dup(const DH_METHOD *dhm);
OSSL_DEPRECATEDIN_3_0 const char *DH_meth_get0_name(const DH_METHOD *dhm);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set1_name(DH_METHOD *dhm, const char *name);
OSSL_DEPRECATEDIN_3_0 int DH_meth_get_flags(const DH_METHOD *dhm);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set_flags(DH_METHOD *dhm, int flags);
OSSL_DEPRECATEDIN_3_0 void *DH_meth_get0_app_data(const DH_METHOD *dhm);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set0_app_data(DH_METHOD *dhm, void *app_data);
OSSL_DEPRECATEDIN_3_0 int (*DH_meth_get_generate_key(const DH_METHOD *dhm))(DH *);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set_generate_key(DH_METHOD *dhm,
    int (*generate_key)(DH *));
OSSL_DEPRECATEDIN_3_0 int (*DH_meth_get_compute_key(const DH_METHOD *dhm))(unsigned char *key,
    const BIGNUM *pub_key,
    DH *dh);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set_compute_key(DH_METHOD *dhm,
    int (*compute_key)(unsigned char *key,
        const BIGNUM *pub_key,
        DH *dh));
OSSL_DEPRECATEDIN_3_0 int (*DH_meth_get_bn_mod_exp(const DH_METHOD *dhm))(const DH *, BIGNUM *,
    const BIGNUM *,
    const BIGNUM *,
    const BIGNUM *, BN_CTX *,
    BN_MONT_CTX *);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set_bn_mod_exp(DH_METHOD *dhm,
    int (*bn_mod_exp)(const DH *, BIGNUM *,
        const BIGNUM *, const BIGNUM *,
        const BIGNUM *, BN_CTX *,
        BN_MONT_CTX *));
OSSL_DEPRECATEDIN_3_0 int (*DH_meth_get_init(const DH_METHOD *dhm))(DH *);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set_init(DH_METHOD *dhm, int (*init)(DH *));
OSSL_DEPRECATEDIN_3_0 int (*DH_meth_get_finish(const DH_METHOD *dhm))(DH *);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set_finish(DH_METHOD *dhm, int (*finish)(DH *));
OSSL_DEPRECATEDIN_3_0 int (*DH_meth_get_generate_params(const DH_METHOD *dhm))(DH *, int, int,
    BN_GENCB *);
OSSL_DEPRECATEDIN_3_0 int DH_meth_set_generate_params(DH_METHOD *dhm,
    int (*generate_params)(DH *, int, int,
        BN_GENCB *));
#endif /* OPENSSL_NO_DEPRECATED_3_0 */

#ifndef OPENSSL_NO_DEPRECATED_0_9_8
OSSL_DEPRECATEDIN_0_9_8 DH *DH_generate_parameters(int prime_len, int generator,
    void (*callback)(int, int,
        void *),
    void *cb_arg);
#endif

#endif
#ifdef __cplusplus
}
#endif
#endif
