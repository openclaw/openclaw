/*
 * Copyright 1995-2021 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_RSA_H
#define OPENSSL_RSA_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_RSA_H
#endif

#include <openssl/opensslconf.h>

#include <openssl/asn1.h>
#include <openssl/bio.h>
#include <openssl/crypto.h>
#include <openssl/types.h>
#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#include <openssl/bn.h>
#endif
#include <openssl/rsaerr.h>
#include <openssl/safestack.h>
#ifndef OPENSSL_NO_STDIO
#include <stdio.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

#ifndef OPENSSL_RSA_MAX_MODULUS_BITS
#define OPENSSL_RSA_MAX_MODULUS_BITS 16384
#endif

#define RSA_3 0x3L
#define RSA_F4 0x10001L

#ifndef OPENSSL_NO_DEPRECATED_3_0
/* The types RSA and RSA_METHOD are defined in ossl_typ.h */

#define OPENSSL_RSA_FIPS_MIN_MODULUS_BITS 2048

#ifndef OPENSSL_RSA_SMALL_MODULUS_BITS
#define OPENSSL_RSA_SMALL_MODULUS_BITS 3072
#endif

/* exponent limit enforced for "large" modulus only */
#ifndef OPENSSL_RSA_MAX_PUBEXP_BITS
#define OPENSSL_RSA_MAX_PUBEXP_BITS 64
#endif
/* based on RFC 8017 appendix A.1.2 */
#define RSA_ASN1_VERSION_DEFAULT 0
#define RSA_ASN1_VERSION_MULTI 1

#define RSA_DEFAULT_PRIME_NUM 2

#define RSA_METHOD_FLAG_NO_CHECK 0x0001
#define RSA_FLAG_CACHE_PUBLIC 0x0002
#define RSA_FLAG_CACHE_PRIVATE 0x0004
#define RSA_FLAG_BLINDING 0x0008
#define RSA_FLAG_THREAD_SAFE 0x0010
/*
 * This flag means the private key operations will be handled by rsa_mod_exp
 * and that they do not depend on the private key components being present:
 * for example a key stored in external hardware. Without this flag
 * bn_mod_exp gets called when private key components are absent.
 */
#define RSA_FLAG_EXT_PKEY 0x0020

/*
 * new with 0.9.6j and 0.9.7b; the built-in
 * RSA implementation now uses blinding by
 * default (ignoring RSA_FLAG_BLINDING),
 * but other engines might not need it
 */
#define RSA_FLAG_NO_BLINDING 0x0080
#endif /* OPENSSL_NO_DEPRECATED_3_0 */
/*
 * Does nothing. Previously this switched off constant time behaviour.
 */
#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define RSA_FLAG_NO_CONSTTIME 0x0000
#endif
/* deprecated name for the flag*/
/*
 * new with 0.9.7h; the built-in RSA
 * implementation now uses constant time
 * modular exponentiation for secret exponents
 * by default. This flag causes the
 * faster variable sliding window method to
 * be used for all exponents.
 */
#ifndef OPENSSL_NO_DEPRECATED_0_9_8
#define RSA_FLAG_NO_EXP_CONSTTIME RSA_FLAG_NO_CONSTTIME
#endif

/*-
 * New with 3.0: use part of the flags to denote exact type of RSA key,
 * some of which are limited to specific signature and encryption schemes.
 * These different types share the same RSA structure, but indicate the
 * use of certain fields in that structure.
 * Currently known are:
 * RSA          - this is the "normal" unlimited RSA structure (typenum 0)
 * RSASSA-PSS   - indicates that the PSS parameters are used.
 * RSAES-OAEP   - no specific field used for the moment, but OAEP padding
 *                is expected.  (currently unused)
 *
 * 4 bits allow for 16 types
 */
#define RSA_FLAG_TYPE_MASK 0xF000
#define RSA_FLAG_TYPE_RSA 0x0000
#define RSA_FLAG_TYPE_RSASSAPSS 0x1000
#define RSA_FLAG_TYPE_RSAESOAEP 0x2000

int EVP_PKEY_CTX_set_rsa_padding(EVP_PKEY_CTX *ctx, int pad_mode);
int EVP_PKEY_CTX_get_rsa_padding(EVP_PKEY_CTX *ctx, int *pad_mode);

int EVP_PKEY_CTX_set_rsa_pss_saltlen(EVP_PKEY_CTX *ctx, int saltlen);
int EVP_PKEY_CTX_get_rsa_pss_saltlen(EVP_PKEY_CTX *ctx, int *saltlen);

int EVP_PKEY_CTX_set_rsa_keygen_bits(EVP_PKEY_CTX *ctx, int bits);
int EVP_PKEY_CTX_set1_rsa_keygen_pubexp(EVP_PKEY_CTX *ctx, BIGNUM *pubexp);
int EVP_PKEY_CTX_set_rsa_keygen_primes(EVP_PKEY_CTX *ctx, int primes);
int EVP_PKEY_CTX_set_rsa_pss_keygen_saltlen(EVP_PKEY_CTX *ctx, int saltlen);
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
int EVP_PKEY_CTX_set_rsa_keygen_pubexp(EVP_PKEY_CTX *ctx, BIGNUM *pubexp);
#endif

/* Salt length matches digest */
#define RSA_PSS_SALTLEN_DIGEST -1
/* Verify only: auto detect salt length */
#define RSA_PSS_SALTLEN_AUTO -2
/* Set salt length to maximum possible */
#define RSA_PSS_SALTLEN_MAX -3
/* Auto-detect on verify, set salt length to min(maximum possible, digest
 * length) on sign */
#define RSA_PSS_SALTLEN_AUTO_DIGEST_MAX -4
/* Old compatible max salt length for sign only */
#define RSA_PSS_SALTLEN_MAX_SIGN -2

int EVP_PKEY_CTX_set_rsa_mgf1_md(EVP_PKEY_CTX *ctx, const EVP_MD *md);
int EVP_PKEY_CTX_set_rsa_mgf1_md_name(EVP_PKEY_CTX *ctx, const char *mdname,
    const char *mdprops);
int EVP_PKEY_CTX_get_rsa_mgf1_md(EVP_PKEY_CTX *ctx, const EVP_MD **md);
int EVP_PKEY_CTX_get_rsa_mgf1_md_name(EVP_PKEY_CTX *ctx, char *name,
    size_t namelen);
int EVP_PKEY_CTX_set_rsa_pss_keygen_mgf1_md(EVP_PKEY_CTX *ctx, const EVP_MD *md);
int EVP_PKEY_CTX_set_rsa_pss_keygen_mgf1_md_name(EVP_PKEY_CTX *ctx,
    const char *mdname);

int EVP_PKEY_CTX_set_rsa_pss_keygen_md(EVP_PKEY_CTX *ctx, const EVP_MD *md);
int EVP_PKEY_CTX_set_rsa_pss_keygen_md_name(EVP_PKEY_CTX *ctx,
    const char *mdname,
    const char *mdprops);

int EVP_PKEY_CTX_set_rsa_oaep_md(EVP_PKEY_CTX *ctx, const EVP_MD *md);
int EVP_PKEY_CTX_set_rsa_oaep_md_name(EVP_PKEY_CTX *ctx, const char *mdname,
    const char *mdprops);
int EVP_PKEY_CTX_get_rsa_oaep_md(EVP_PKEY_CTX *ctx, const EVP_MD **md);
int EVP_PKEY_CTX_get_rsa_oaep_md_name(EVP_PKEY_CTX *ctx, char *name,
    size_t namelen);
int EVP_PKEY_CTX_set0_rsa_oaep_label(EVP_PKEY_CTX *ctx, void *label, int llen);
int EVP_PKEY_CTX_get0_rsa_oaep_label(EVP_PKEY_CTX *ctx, unsigned char **label);

#define EVP_PKEY_CTRL_RSA_PADDING (EVP_PKEY_ALG_CTRL + 1)
#define EVP_PKEY_CTRL_RSA_PSS_SALTLEN (EVP_PKEY_ALG_CTRL + 2)

#define EVP_PKEY_CTRL_RSA_KEYGEN_BITS (EVP_PKEY_ALG_CTRL + 3)
#define EVP_PKEY_CTRL_RSA_KEYGEN_PUBEXP (EVP_PKEY_ALG_CTRL + 4)
#define EVP_PKEY_CTRL_RSA_MGF1_MD (EVP_PKEY_ALG_CTRL + 5)

#define EVP_PKEY_CTRL_GET_RSA_PADDING (EVP_PKEY_ALG_CTRL + 6)
#define EVP_PKEY_CTRL_GET_RSA_PSS_SALTLEN (EVP_PKEY_ALG_CTRL + 7)
#define EVP_PKEY_CTRL_GET_RSA_MGF1_MD (EVP_PKEY_ALG_CTRL + 8)

#define EVP_PKEY_CTRL_RSA_OAEP_MD (EVP_PKEY_ALG_CTRL + 9)
#define EVP_PKEY_CTRL_RSA_OAEP_LABEL (EVP_PKEY_ALG_CTRL + 10)

#define EVP_PKEY_CTRL_GET_RSA_OAEP_MD (EVP_PKEY_ALG_CTRL + 11)
#define EVP_PKEY_CTRL_GET_RSA_OAEP_LABEL (EVP_PKEY_ALG_CTRL + 12)

#define EVP_PKEY_CTRL_RSA_KEYGEN_PRIMES (EVP_PKEY_ALG_CTRL + 13)

#define EVP_PKEY_CTRL_RSA_IMPLICIT_REJECTION (EVP_PKEY_ALG_CTRL + 14)

#define RSA_PKCS1_PADDING 1
#define RSA_NO_PADDING 3
#define RSA_PKCS1_OAEP_PADDING 4
#define RSA_X931_PADDING 5

/* EVP_PKEY_ only */
#define RSA_PKCS1_PSS_PADDING 6
#define RSA_PKCS1_WITH_TLS_PADDING 7

/* internal RSA_ only */
#define RSA_PKCS1_NO_IMPLICIT_REJECT_PADDING 8

#define RSA_PKCS1_PADDING_SIZE 11

#define RSA_set_app_data(s, arg) RSA_set_ex_data(s, 0, arg)
#define RSA_get_app_data(s) RSA_get_ex_data(s, 0)

#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 RSA *RSA_new(void);
OSSL_DEPRECATEDIN_3_0 RSA *RSA_new_method(ENGINE *engine);
OSSL_DEPRECATEDIN_3_0 int RSA_bits(const RSA *rsa);
OSSL_DEPRECATEDIN_3_0 int RSA_size(const RSA *rsa);
OSSL_DEPRECATEDIN_3_0 int RSA_security_bits(const RSA *rsa);

OSSL_DEPRECATEDIN_3_0 int RSA_set0_key(RSA *r, BIGNUM *n, BIGNUM *e, BIGNUM *d);
OSSL_DEPRECATEDIN_3_0 int RSA_set0_factors(RSA *r, BIGNUM *p, BIGNUM *q);
OSSL_DEPRECATEDIN_3_0 int RSA_set0_crt_params(RSA *r,
    BIGNUM *dmp1, BIGNUM *dmq1,
    BIGNUM *iqmp);
OSSL_DEPRECATEDIN_3_0 int RSA_set0_multi_prime_params(RSA *r,
    BIGNUM *primes[],
    BIGNUM *exps[],
    BIGNUM *coeffs[],
    int pnum);
OSSL_DEPRECATEDIN_3_0 void RSA_get0_key(const RSA *r,
    const BIGNUM **n, const BIGNUM **e,
    const BIGNUM **d);
OSSL_DEPRECATEDIN_3_0 void RSA_get0_factors(const RSA *r,
    const BIGNUM **p, const BIGNUM **q);
OSSL_DEPRECATEDIN_3_0 int RSA_get_multi_prime_extra_count(const RSA *r);
OSSL_DEPRECATEDIN_3_0 int RSA_get0_multi_prime_factors(const RSA *r,
    const BIGNUM *primes[]);
OSSL_DEPRECATEDIN_3_0 void RSA_get0_crt_params(const RSA *r,
    const BIGNUM **dmp1,
    const BIGNUM **dmq1,
    const BIGNUM **iqmp);
OSSL_DEPRECATEDIN_3_0
int RSA_get0_multi_prime_crt_params(const RSA *r, const BIGNUM *exps[],
    const BIGNUM *coeffs[]);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *RSA_get0_n(const RSA *d);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *RSA_get0_e(const RSA *d);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *RSA_get0_d(const RSA *d);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *RSA_get0_p(const RSA *d);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *RSA_get0_q(const RSA *d);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *RSA_get0_dmp1(const RSA *r);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *RSA_get0_dmq1(const RSA *r);
OSSL_DEPRECATEDIN_3_0 const BIGNUM *RSA_get0_iqmp(const RSA *r);
OSSL_DEPRECATEDIN_3_0 const RSA_PSS_PARAMS *RSA_get0_pss_params(const RSA *r);
OSSL_DEPRECATEDIN_3_0 void RSA_clear_flags(RSA *r, int flags);
OSSL_DEPRECATEDIN_3_0 int RSA_test_flags(const RSA *r, int flags);
OSSL_DEPRECATEDIN_3_0 void RSA_set_flags(RSA *r, int flags);
OSSL_DEPRECATEDIN_3_0 int RSA_get_version(RSA *r);
OSSL_DEPRECATEDIN_3_0 ENGINE *RSA_get0_engine(const RSA *r);
#endif /* !OPENSSL_NO_DEPRECATED_3_0 */

#define EVP_RSA_gen(bits) \
    EVP_PKEY_Q_keygen(NULL, NULL, "RSA", (size_t)(0 + (bits)))

/* Deprecated version */
#ifndef OPENSSL_NO_DEPRECATED_0_9_8
OSSL_DEPRECATEDIN_0_9_8 RSA *RSA_generate_key(int bits, unsigned long e, void (*callback)(int, int, void *),
    void *cb_arg);
#endif

/* New version */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int RSA_generate_key_ex(RSA *rsa, int bits, BIGNUM *e,
    BN_GENCB *cb);
/* Multi-prime version */
OSSL_DEPRECATEDIN_3_0 int RSA_generate_multi_prime_key(RSA *rsa, int bits,
    int primes, BIGNUM *e,
    BN_GENCB *cb);

OSSL_DEPRECATEDIN_3_0
int RSA_X931_derive_ex(RSA *rsa, BIGNUM *p1, BIGNUM *p2,
    BIGNUM *q1, BIGNUM *q2,
    const BIGNUM *Xp1, const BIGNUM *Xp2,
    const BIGNUM *Xp, const BIGNUM *Xq1,
    const BIGNUM *Xq2, const BIGNUM *Xq,
    const BIGNUM *e, BN_GENCB *cb);
OSSL_DEPRECATEDIN_3_0 int RSA_X931_generate_key_ex(RSA *rsa, int bits,
    const BIGNUM *e,
    BN_GENCB *cb);

OSSL_DEPRECATEDIN_3_0 int RSA_check_key(const RSA *);
OSSL_DEPRECATEDIN_3_0 int RSA_check_key_ex(const RSA *, BN_GENCB *cb);
/* next 4 return -1 on error */
OSSL_DEPRECATEDIN_3_0
int RSA_public_encrypt(int flen, const unsigned char *from, unsigned char *to,
    RSA *rsa, int padding);
OSSL_DEPRECATEDIN_3_0
int RSA_private_encrypt(int flen, const unsigned char *from, unsigned char *to,
    RSA *rsa, int padding);
OSSL_DEPRECATEDIN_3_0
int RSA_public_decrypt(int flen, const unsigned char *from, unsigned char *to,
    RSA *rsa, int padding);
OSSL_DEPRECATEDIN_3_0
int RSA_private_decrypt(int flen, const unsigned char *from, unsigned char *to,
    RSA *rsa, int padding);
OSSL_DEPRECATEDIN_3_0 void RSA_free(RSA *r);
/* "up" the RSA object's reference count */
OSSL_DEPRECATEDIN_3_0 int RSA_up_ref(RSA *r);
OSSL_DEPRECATEDIN_3_0 int RSA_flags(const RSA *r);

OSSL_DEPRECATEDIN_3_0 void RSA_set_default_method(const RSA_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 const RSA_METHOD *RSA_get_default_method(void);
OSSL_DEPRECATEDIN_3_0 const RSA_METHOD *RSA_null_method(void);
OSSL_DEPRECATEDIN_3_0 const RSA_METHOD *RSA_get_method(const RSA *rsa);
OSSL_DEPRECATEDIN_3_0 int RSA_set_method(RSA *rsa, const RSA_METHOD *meth);

/* these are the actual RSA functions */
OSSL_DEPRECATEDIN_3_0 const RSA_METHOD *RSA_PKCS1_OpenSSL(void);

DECLARE_ASN1_ENCODE_FUNCTIONS_name_attr(OSSL_DEPRECATEDIN_3_0,
    RSA, RSAPublicKey)
DECLARE_ASN1_ENCODE_FUNCTIONS_name_attr(OSSL_DEPRECATEDIN_3_0,
    RSA, RSAPrivateKey)
#endif /* !OPENSSL_NO_DEPRECATED_3_0 */

int RSA_pkey_ctx_ctrl(EVP_PKEY_CTX *ctx, int optype, int cmd, int p1, void *p2);

struct rsa_pss_params_st {
    X509_ALGOR *hashAlgorithm;
    X509_ALGOR *maskGenAlgorithm;
    ASN1_INTEGER *saltLength;
    ASN1_INTEGER *trailerField;
    /* Decoded hash algorithm from maskGenAlgorithm */
    X509_ALGOR *maskHash;
};

DECLARE_ASN1_FUNCTIONS(RSA_PSS_PARAMS)
DECLARE_ASN1_DUP_FUNCTION(RSA_PSS_PARAMS)

typedef struct rsa_oaep_params_st {
    X509_ALGOR *hashFunc;
    X509_ALGOR *maskGenFunc;
    X509_ALGOR *pSourceFunc;
    /* Decoded hash algorithm from maskGenFunc */
    X509_ALGOR *maskHash;
} RSA_OAEP_PARAMS;

DECLARE_ASN1_FUNCTIONS(RSA_OAEP_PARAMS)

#ifndef OPENSSL_NO_DEPRECATED_3_0
#ifndef OPENSSL_NO_STDIO
OSSL_DEPRECATEDIN_3_0 int RSA_print_fp(FILE *fp, const RSA *r, int offset);
#endif

OSSL_DEPRECATEDIN_3_0 int RSA_print(BIO *bp, const RSA *r, int offset);

/*
 * The following 2 functions sign and verify a X509_SIG ASN1 object inside
 * PKCS#1 padded RSA encryption
 */
OSSL_DEPRECATEDIN_3_0 int RSA_sign(int type, const unsigned char *m,
    unsigned int m_length, unsigned char *sigret,
    unsigned int *siglen, RSA *rsa);
OSSL_DEPRECATEDIN_3_0 int RSA_verify(int type, const unsigned char *m,
    unsigned int m_length,
    const unsigned char *sigbuf,
    unsigned int siglen, RSA *rsa);

/*
 * The following 2 function sign and verify a ASN1_OCTET_STRING object inside
 * PKCS#1 padded RSA encryption
 */
OSSL_DEPRECATEDIN_3_0
int RSA_sign_ASN1_OCTET_STRING(int type,
    const unsigned char *m, unsigned int m_length,
    unsigned char *sigret, unsigned int *siglen,
    RSA *rsa);
OSSL_DEPRECATEDIN_3_0
int RSA_verify_ASN1_OCTET_STRING(int type,
    const unsigned char *m, unsigned int m_length,
    unsigned char *sigbuf, unsigned int siglen,
    RSA *rsa);

OSSL_DEPRECATEDIN_3_0 int RSA_blinding_on(RSA *rsa, BN_CTX *ctx);
OSSL_DEPRECATEDIN_3_0 void RSA_blinding_off(RSA *rsa);
OSSL_DEPRECATEDIN_3_0 BN_BLINDING *RSA_setup_blinding(RSA *rsa, BN_CTX *ctx);

OSSL_DEPRECATEDIN_3_0
int RSA_padding_add_PKCS1_type_1(unsigned char *to, int tlen,
    const unsigned char *f, int fl);
OSSL_DEPRECATEDIN_3_0
int RSA_padding_check_PKCS1_type_1(unsigned char *to, int tlen,
    const unsigned char *f, int fl,
    int rsa_len);
OSSL_DEPRECATEDIN_3_0
int RSA_padding_add_PKCS1_type_2(unsigned char *to, int tlen,
    const unsigned char *f, int fl);
OSSL_DEPRECATEDIN_3_0
int RSA_padding_check_PKCS1_type_2(unsigned char *to, int tlen,
    const unsigned char *f, int fl,
    int rsa_len);
OSSL_DEPRECATEDIN_3_0 int PKCS1_MGF1(unsigned char *mask, long len,
    const unsigned char *seed, long seedlen,
    const EVP_MD *dgst);
OSSL_DEPRECATEDIN_3_0
int RSA_padding_add_PKCS1_OAEP(unsigned char *to, int tlen,
    const unsigned char *f, int fl,
    const unsigned char *p, int pl);
OSSL_DEPRECATEDIN_3_0
int RSA_padding_check_PKCS1_OAEP(unsigned char *to, int tlen,
    const unsigned char *f, int fl, int rsa_len,
    const unsigned char *p, int pl);
OSSL_DEPRECATEDIN_3_0
int RSA_padding_add_PKCS1_OAEP_mgf1(unsigned char *to, int tlen,
    const unsigned char *from, int flen,
    const unsigned char *param, int plen,
    const EVP_MD *md, const EVP_MD *mgf1md);
OSSL_DEPRECATEDIN_3_0
int RSA_padding_check_PKCS1_OAEP_mgf1(unsigned char *to, int tlen,
    const unsigned char *from, int flen,
    int num,
    const unsigned char *param, int plen,
    const EVP_MD *md, const EVP_MD *mgf1md);
OSSL_DEPRECATEDIN_3_0 int RSA_padding_add_none(unsigned char *to, int tlen,
    const unsigned char *f, int fl);
OSSL_DEPRECATEDIN_3_0 int RSA_padding_check_none(unsigned char *to, int tlen,
    const unsigned char *f, int fl,
    int rsa_len);
OSSL_DEPRECATEDIN_3_0 int RSA_padding_add_X931(unsigned char *to, int tlen,
    const unsigned char *f, int fl);
OSSL_DEPRECATEDIN_3_0 int RSA_padding_check_X931(unsigned char *to, int tlen,
    const unsigned char *f, int fl,
    int rsa_len);
OSSL_DEPRECATEDIN_3_0 int RSA_X931_hash_id(int nid);

OSSL_DEPRECATEDIN_3_0
int RSA_verify_PKCS1_PSS(RSA *rsa, const unsigned char *mHash,
    const EVP_MD *Hash, const unsigned char *EM,
    int sLen);
OSSL_DEPRECATEDIN_3_0
int RSA_padding_add_PKCS1_PSS(RSA *rsa, unsigned char *EM,
    const unsigned char *mHash, const EVP_MD *Hash,
    int sLen);

OSSL_DEPRECATEDIN_3_0
int RSA_verify_PKCS1_PSS_mgf1(RSA *rsa, const unsigned char *mHash,
    const EVP_MD *Hash, const EVP_MD *mgf1Hash,
    const unsigned char *EM, int sLen);

OSSL_DEPRECATEDIN_3_0
int RSA_padding_add_PKCS1_PSS_mgf1(RSA *rsa, unsigned char *EM,
    const unsigned char *mHash,
    const EVP_MD *Hash, const EVP_MD *mgf1Hash,
    int sLen);

#define RSA_get_ex_new_index(l, p, newf, dupf, freef) \
    CRYPTO_get_ex_new_index(CRYPTO_EX_INDEX_RSA, l, p, newf, dupf, freef)
OSSL_DEPRECATEDIN_3_0 int RSA_set_ex_data(RSA *r, int idx, void *arg);
OSSL_DEPRECATEDIN_3_0 void *RSA_get_ex_data(const RSA *r, int idx);

DECLARE_ASN1_DUP_FUNCTION_name_attr(OSSL_DEPRECATEDIN_3_0, RSA, RSAPublicKey)
DECLARE_ASN1_DUP_FUNCTION_name_attr(OSSL_DEPRECATEDIN_3_0, RSA, RSAPrivateKey)

/*
 * If this flag is set the RSA method is FIPS compliant and can be used in
 * FIPS mode. This is set in the validated module method. If an application
 * sets this flag in its own methods it is its responsibility to ensure the
 * result is compliant.
 */

#define RSA_FLAG_FIPS_METHOD 0x0400

/*
 * If this flag is set the operations normally disabled in FIPS mode are
 * permitted it is then the applications responsibility to ensure that the
 * usage is compliant.
 */

#define RSA_FLAG_NON_FIPS_ALLOW 0x0400
/*
 * Application has decided PRNG is good enough to generate a key: don't
 * check.
 */
#define RSA_FLAG_CHECKED 0x0800

OSSL_DEPRECATEDIN_3_0 RSA_METHOD *RSA_meth_new(const char *name, int flags);
OSSL_DEPRECATEDIN_3_0 void RSA_meth_free(RSA_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 RSA_METHOD *RSA_meth_dup(const RSA_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 const char *RSA_meth_get0_name(const RSA_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 int RSA_meth_set1_name(RSA_METHOD *meth,
    const char *name);
OSSL_DEPRECATEDIN_3_0 int RSA_meth_get_flags(const RSA_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 int RSA_meth_set_flags(RSA_METHOD *meth, int flags);
OSSL_DEPRECATEDIN_3_0 void *RSA_meth_get0_app_data(const RSA_METHOD *meth);
OSSL_DEPRECATEDIN_3_0 int RSA_meth_set0_app_data(RSA_METHOD *meth,
    void *app_data);
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_pub_enc(const RSA_METHOD *meth))(int flen,
    const unsigned char *from,
    unsigned char *to,
    RSA *rsa, int padding);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_pub_enc(RSA_METHOD *rsa,
    int (*pub_enc)(int flen, const unsigned char *from,
        unsigned char *to, RSA *rsa,
        int padding));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_pub_dec(const RSA_METHOD *meth))(int flen,
    const unsigned char *from,
    unsigned char *to,
    RSA *rsa, int padding);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_pub_dec(RSA_METHOD *rsa,
    int (*pub_dec)(int flen, const unsigned char *from,
        unsigned char *to, RSA *rsa,
        int padding));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_priv_enc(const RSA_METHOD *meth))(int flen,
    const unsigned char *from,
    unsigned char *to,
    RSA *rsa, int padding);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_priv_enc(RSA_METHOD *rsa,
    int (*priv_enc)(int flen, const unsigned char *from,
        unsigned char *to, RSA *rsa,
        int padding));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_priv_dec(const RSA_METHOD *meth))(int flen,
    const unsigned char *from,
    unsigned char *to,
    RSA *rsa, int padding);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_priv_dec(RSA_METHOD *rsa,
    int (*priv_dec)(int flen, const unsigned char *from,
        unsigned char *to, RSA *rsa,
        int padding));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_mod_exp(const RSA_METHOD *meth))(BIGNUM *r0,
    const BIGNUM *i,
    RSA *rsa, BN_CTX *ctx);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_mod_exp(RSA_METHOD *rsa,
    int (*mod_exp)(BIGNUM *r0, const BIGNUM *i, RSA *rsa,
        BN_CTX *ctx));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_bn_mod_exp(const RSA_METHOD *meth))(BIGNUM *r,
    const BIGNUM *a,
    const BIGNUM *p,
    const BIGNUM *m,
    BN_CTX *ctx,
    BN_MONT_CTX *m_ctx);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_bn_mod_exp(RSA_METHOD *rsa,
    int (*bn_mod_exp)(BIGNUM *r,
        const BIGNUM *a,
        const BIGNUM *p,
        const BIGNUM *m,
        BN_CTX *ctx,
        BN_MONT_CTX *m_ctx));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_init(const RSA_METHOD *meth))(RSA *rsa);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_init(RSA_METHOD *rsa, int (*init)(RSA *rsa));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_finish(const RSA_METHOD *meth))(RSA *rsa);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_finish(RSA_METHOD *rsa, int (*finish)(RSA *rsa));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_sign(const RSA_METHOD *meth))(int type,
    const unsigned char *m,
    unsigned int m_length,
    unsigned char *sigret,
    unsigned int *siglen,
    const RSA *rsa);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_sign(RSA_METHOD *rsa,
    int (*sign)(int type, const unsigned char *m,
        unsigned int m_length,
        unsigned char *sigret, unsigned int *siglen,
        const RSA *rsa));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_verify(const RSA_METHOD *meth))(int dtype,
    const unsigned char *m,
    unsigned int m_length,
    const unsigned char *sigbuf,
    unsigned int siglen,
    const RSA *rsa);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_verify(RSA_METHOD *rsa,
    int (*verify)(int dtype, const unsigned char *m,
        unsigned int m_length,
        const unsigned char *sigbuf,
        unsigned int siglen, const RSA *rsa));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_keygen(const RSA_METHOD *meth))(RSA *rsa, int bits,
    BIGNUM *e, BN_GENCB *cb);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_keygen(RSA_METHOD *rsa,
    int (*keygen)(RSA *rsa, int bits, BIGNUM *e,
        BN_GENCB *cb));
OSSL_DEPRECATEDIN_3_0
int (*RSA_meth_get_multi_prime_keygen(const RSA_METHOD *meth))(RSA *rsa,
    int bits,
    int primes,
    BIGNUM *e,
    BN_GENCB *cb);
OSSL_DEPRECATEDIN_3_0
int RSA_meth_set_multi_prime_keygen(RSA_METHOD *meth,
    int (*keygen)(RSA *rsa, int bits,
        int primes, BIGNUM *e,
        BN_GENCB *cb));
#endif /* !OPENSSL_NO_DEPRECATED_3_0 */

#ifdef __cplusplus
}
#endif
#endif
