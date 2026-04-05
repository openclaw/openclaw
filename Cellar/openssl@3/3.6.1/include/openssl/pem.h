/*
 * Copyright 1995-2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_PEM_H
#define OPENSSL_PEM_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_PEM_H
#endif

#include <openssl/e_os2.h>
#include <openssl/bio.h>
#include <openssl/safestack.h>
#include <openssl/evp.h>
#include <openssl/x509.h>
#include <openssl/pemerr.h>
#ifndef OPENSSL_NO_STDIO
#include <stdio.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define PEM_BUFSIZE 1024

#define PEM_STRING_X509_OLD "X509 CERTIFICATE"
#define PEM_STRING_X509 "CERTIFICATE"
#define PEM_STRING_X509_TRUSTED "TRUSTED CERTIFICATE"
#define PEM_STRING_X509_REQ_OLD "NEW CERTIFICATE REQUEST"
#define PEM_STRING_X509_REQ "CERTIFICATE REQUEST"
#define PEM_STRING_X509_CRL "X509 CRL"
#define PEM_STRING_EVP_PKEY "ANY PRIVATE KEY"
#define PEM_STRING_PUBLIC "PUBLIC KEY"
#define PEM_STRING_RSA "RSA PRIVATE KEY"
#define PEM_STRING_RSA_PUBLIC "RSA PUBLIC KEY"
#define PEM_STRING_DSA "DSA PRIVATE KEY"
#define PEM_STRING_DSA_PUBLIC "DSA PUBLIC KEY"
#define PEM_STRING_PKCS7 "PKCS7"
#define PEM_STRING_PKCS7_SIGNED "PKCS #7 SIGNED DATA"
#define PEM_STRING_PKCS8 "ENCRYPTED PRIVATE KEY"
#define PEM_STRING_PKCS8INF "PRIVATE KEY"
#define PEM_STRING_DHPARAMS "DH PARAMETERS"
#define PEM_STRING_DHXPARAMS "X9.42 DH PARAMETERS"
#define PEM_STRING_SSL_SESSION "SSL SESSION PARAMETERS"
#define PEM_STRING_DSAPARAMS "DSA PARAMETERS"
#define PEM_STRING_ECDSA_PUBLIC "ECDSA PUBLIC KEY"
#define PEM_STRING_ECPARAMETERS "EC PARAMETERS"
#define PEM_STRING_ECPRIVATEKEY "EC PRIVATE KEY"
#define PEM_STRING_PARAMETERS "PARAMETERS"
#define PEM_STRING_CMS "CMS"
#define PEM_STRING_SM2PRIVATEKEY "SM2 PRIVATE KEY"
#define PEM_STRING_SM2PARAMETERS "SM2 PARAMETERS"
#define PEM_STRING_ACERT "ATTRIBUTE CERTIFICATE"

#define PEM_TYPE_ENCRYPTED 10
#define PEM_TYPE_MIC_ONLY 20
#define PEM_TYPE_MIC_CLEAR 30
#define PEM_TYPE_CLEAR 40

/*
 * These macros make the PEM_read/PEM_write functions easier to maintain and
 * write. Now they are all implemented with either: IMPLEMENT_PEM_rw(...) or
 * IMPLEMENT_PEM_rw_cb(...)
 */

#define PEM_read_cb_fnsig(name, type, INTYPE, readname)  \
    type *PEM_##readname##_##name(INTYPE *out, type **x, \
        pem_password_cb *cb, void *u)
#define PEM_read_cb_ex_fnsig(name, type, INTYPE, readname)    \
    type *PEM_##readname##_##name##_ex(INTYPE *out, type **x, \
        pem_password_cb *cb, void *u,                         \
        OSSL_LIB_CTX *libctx,                                 \
        const char *propq)

#define PEM_write_fnsig(name, type, OUTTYPE, writename) \
    int PEM_##writename##_##name(OUTTYPE *out, const type *x)
#define PEM_write_cb_fnsig(name, type, OUTTYPE, writename)    \
    int PEM_##writename##_##name(OUTTYPE *out, const type *x, \
        const EVP_CIPHER *enc,                                \
        const unsigned char *kstr, int klen,                  \
        pem_password_cb *cb, void *u)
#define PEM_write_ex_fnsig(name, type, OUTTYPE, writename)         \
    int PEM_##writename##_##name##_ex(OUTTYPE *out, const type *x, \
        OSSL_LIB_CTX *libctx,                                      \
        const char *propq)
#define PEM_write_cb_ex_fnsig(name, type, OUTTYPE, writename)      \
    int PEM_##writename##_##name##_ex(OUTTYPE *out, const type *x, \
        const EVP_CIPHER *enc,                                     \
        const unsigned char *kstr, int klen,                       \
        pem_password_cb *cb, void *u,                              \
        OSSL_LIB_CTX *libctx,                                      \
        const char *propq)

#ifdef OPENSSL_NO_STDIO

#define IMPLEMENT_PEM_read_fp(name, type, str, asn1) /**/
#define IMPLEMENT_PEM_write_fp(name, type, str, asn1) /**/
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_write_fp_const(name, type, str, asn1) /**/
#endif
#define IMPLEMENT_PEM_write_cb_fp(name, type, str, asn1) /**/
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_write_cb_fp_const(name, type, str, asn1) /**/
#endif
#else

#define IMPLEMENT_PEM_read_fp(name, type, str, asn1)                        \
    type *PEM_read_##name(FILE *fp, type **x, pem_password_cb *cb, void *u) \
    {                                                                       \
        return PEM_ASN1_read((d2i_of_void *)d2i_##asn1, str, fp,            \
            (void **)x, cb, u);                                             \
    }

#define IMPLEMENT_PEM_write_fp(name, type, str, asn1)              \
    PEM_write_fnsig(name, type, FILE, write)                       \
    {                                                              \
        return PEM_ASN1_write((i2d_of_void *)i2d_##asn1, str, out, \
            x, NULL, NULL, 0, NULL, NULL);                         \
    }

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_write_fp_const(name, type, str, asn1) \
    IMPLEMENT_PEM_write_fp(name, type, str, asn1)
#endif

#define IMPLEMENT_PEM_write_cb_fp(name, type, str, asn1)           \
    PEM_write_cb_fnsig(name, type, FILE, write)                    \
    {                                                              \
        return PEM_ASN1_write((i2d_of_void *)i2d_##asn1, str, out, \
            x, enc, kstr, klen, cb, u);                            \
    }

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_write_cb_fp_const(name, type, str, asn1) \
    IMPLEMENT_PEM_write_cb_fp(name, type, str, asn1)
#endif
#endif

#define IMPLEMENT_PEM_read_bio(name, type, str, asn1)                \
    type *PEM_read_bio_##name(BIO *bp, type **x,                     \
        pem_password_cb *cb, void *u)                                \
    {                                                                \
        return PEM_ASN1_read_bio((d2i_of_void *)d2i_##asn1, str, bp, \
            (void **)x, cb, u);                                      \
    }

#define IMPLEMENT_PEM_write_bio(name, type, str, asn1)                 \
    PEM_write_fnsig(name, type, BIO, write_bio)                        \
    {                                                                  \
        return PEM_ASN1_write_bio((i2d_of_void *)i2d_##asn1, str, out, \
            x, NULL, NULL, 0, NULL, NULL);                             \
    }

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_write_bio_const(name, type, str, asn1) \
    IMPLEMENT_PEM_write_bio(name, type, str, asn1)
#endif

#define IMPLEMENT_PEM_write_cb_bio(name, type, str, asn1)              \
    PEM_write_cb_fnsig(name, type, BIO, write_bio)                     \
    {                                                                  \
        return PEM_ASN1_write_bio((i2d_of_void *)i2d_##asn1, str, out, \
            x, enc, kstr, klen, cb, u);                                \
    }

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_write_cb_bio_const(name, type, str, asn1) \
    IMPLEMENT_PEM_write_cb_bio(name, type, str, asn1)
#endif

#define IMPLEMENT_PEM_write(name, type, str, asn1) \
    IMPLEMENT_PEM_write_bio(name, type, str, asn1) \
    IMPLEMENT_PEM_write_fp(name, type, str, asn1)

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_write_const(name, type, str, asn1) \
    IMPLEMENT_PEM_write_bio_const(name, type, str, asn1) \
    IMPLEMENT_PEM_write_fp_const(name, type, str, asn1)
#endif

#define IMPLEMENT_PEM_write_cb(name, type, str, asn1) \
    IMPLEMENT_PEM_write_cb_bio(name, type, str, asn1) \
    IMPLEMENT_PEM_write_cb_fp(name, type, str, asn1)

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_write_cb_const(name, type, str, asn1) \
    IMPLEMENT_PEM_write_cb_bio_const(name, type, str, asn1) \
    IMPLEMENT_PEM_write_cb_fp_const(name, type, str, asn1)
#endif

#define IMPLEMENT_PEM_read(name, type, str, asn1) \
    IMPLEMENT_PEM_read_bio(name, type, str, asn1) \
    IMPLEMENT_PEM_read_fp(name, type, str, asn1)

#define IMPLEMENT_PEM_rw(name, type, str, asn1) \
    IMPLEMENT_PEM_read(name, type, str, asn1)   \
    IMPLEMENT_PEM_write(name, type, str, asn1)

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define IMPLEMENT_PEM_rw_const(name, type, str, asn1) \
    IMPLEMENT_PEM_read(name, type, str, asn1)         \
    IMPLEMENT_PEM_write_const(name, type, str, asn1)
#endif

#define IMPLEMENT_PEM_rw_cb(name, type, str, asn1) \
    IMPLEMENT_PEM_read(name, type, str, asn1)      \
    IMPLEMENT_PEM_write_cb(name, type, str, asn1)

/* These are the same except they are for the declarations */

/*
 * The mysterious 'extern' that's passed to some macros is innocuous,
 * and is there to quiet pre-C99 compilers that may complain about empty
 * arguments in macro calls.
 */
#if defined(OPENSSL_NO_STDIO)

#define DECLARE_PEM_read_fp_attr(attr, name, type) /**/
#define DECLARE_PEM_read_fp_ex_attr(attr, name, type) /**/
#define DECLARE_PEM_write_fp_attr(attr, name, type) /**/
#define DECLARE_PEM_write_fp_ex_attr(attr, name, type) /**/
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define DECLARE_PEM_write_fp_const_attr(attr, name, type) /**/
#endif
#define DECLARE_PEM_write_cb_fp_attr(attr, name, type) /**/
#define DECLARE_PEM_write_cb_fp_ex_attr(attr, name, type) /**/

#else

#define DECLARE_PEM_read_fp_attr(attr, name, type) \
    attr PEM_read_cb_fnsig(name, type, FILE, read);
#define DECLARE_PEM_read_fp_ex_attr(attr, name, type) \
    attr PEM_read_cb_fnsig(name, type, FILE, read);   \
    attr PEM_read_cb_ex_fnsig(name, type, FILE, read);

#define DECLARE_PEM_write_fp_attr(attr, name, type) \
    attr PEM_write_fnsig(name, type, FILE, write);
#define DECLARE_PEM_write_fp_ex_attr(attr, name, type) \
    attr PEM_write_fnsig(name, type, FILE, write);     \
    attr PEM_write_ex_fnsig(name, type, FILE, write);
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define DECLARE_PEM_write_fp_const_attr(attr, name, type) \
    attr PEM_write_fnsig(name, type, FILE, write);
#endif
#define DECLARE_PEM_write_cb_fp_attr(attr, name, type) \
    attr PEM_write_cb_fnsig(name, type, FILE, write);
#define DECLARE_PEM_write_cb_fp_ex_attr(attr, name, type) \
    attr PEM_write_cb_fnsig(name, type, FILE, write);     \
    attr PEM_write_cb_ex_fnsig(name, type, FILE, write);

#endif

#define DECLARE_PEM_read_fp(name, type) \
    DECLARE_PEM_read_fp_attr(extern, name, type)
#define DECLARE_PEM_write_fp(name, type) \
    DECLARE_PEM_write_fp_attr(extern, name, type)
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define DECLARE_PEM_write_fp_const(name, type) \
    DECLARE_PEM_write_fp_const_attr(extern, name, type)
#endif
#define DECLARE_PEM_write_cb_fp(name, type) \
    DECLARE_PEM_write_cb_fp_attr(extern, name, type)

#define DECLARE_PEM_read_bio_attr(attr, name, type) \
    attr PEM_read_cb_fnsig(name, type, BIO, read_bio);
#define DECLARE_PEM_read_bio_ex_attr(attr, name, type) \
    attr PEM_read_cb_fnsig(name, type, BIO, read_bio); \
    attr PEM_read_cb_ex_fnsig(name, type, BIO, read_bio);
#define DECLARE_PEM_read_bio(name, type) \
    DECLARE_PEM_read_bio_attr(extern, name, type)
#define DECLARE_PEM_read_bio_ex(name, type) \
    DECLARE_PEM_read_bio_ex_attr(extern, name, type)

#define DECLARE_PEM_write_bio_attr(attr, name, type) \
    attr PEM_write_fnsig(name, type, BIO, write_bio);
#define DECLARE_PEM_write_bio_ex_attr(attr, name, type) \
    attr PEM_write_fnsig(name, type, BIO, write_bio);   \
    attr PEM_write_ex_fnsig(name, type, BIO, write_bio);
#define DECLARE_PEM_write_bio(name, type) \
    DECLARE_PEM_write_bio_attr(extern, name, type)
#define DECLARE_PEM_write_bio_ex(name, type) \
    DECLARE_PEM_write_bio_ex_attr(extern, name, type)

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define DECLARE_PEM_write_bio_const_attr(attr, name, type) \
    attr PEM_write_fnsig(name, type, BIO, write_bio);
#define DECLARE_PEM_write_bio_const(name, type) \
    DECLARE_PEM_write_bio_const_attr(extern, name, type)
#endif

#define DECLARE_PEM_write_cb_bio_attr(attr, name, type) \
    attr PEM_write_cb_fnsig(name, type, BIO, write_bio);
#define DECLARE_PEM_write_cb_bio_ex_attr(attr, name, type) \
    attr PEM_write_cb_fnsig(name, type, BIO, write_bio);   \
    attr PEM_write_cb_ex_fnsig(name, type, BIO, write_bio);
#define DECLARE_PEM_write_cb_bio(name, type) \
    DECLARE_PEM_write_cb_bio_attr(extern, name, type)
#define DECLARE_PEM_write_cb_ex_bio(name, type) \
    DECLARE_PEM_write_cb_bio_ex_attr(extern, name, type)

#define DECLARE_PEM_write_attr(attr, name, type) \
    DECLARE_PEM_write_bio_attr(attr, name, type) \
    DECLARE_PEM_write_fp_attr(attr, name, type)
#define DECLARE_PEM_write_ex_attr(attr, name, type) \
    DECLARE_PEM_write_bio_ex_attr(attr, name, type) \
    DECLARE_PEM_write_fp_ex_attr(attr, name, type)
#define DECLARE_PEM_write(name, type) \
    DECLARE_PEM_write_attr(extern, name, type)
#define DECLARE_PEM_write_ex(name, type) \
    DECLARE_PEM_write_ex_attr(extern, name, type)
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define DECLARE_PEM_write_const_attr(attr, name, type) \
    DECLARE_PEM_write_bio_const_attr(attr, name, type) \
    DECLARE_PEM_write_fp_const_attr(attr, name, type)
#define DECLARE_PEM_write_const(name, type) \
    DECLARE_PEM_write_const_attr(extern, name, type)
#endif
#define DECLARE_PEM_write_cb_attr(attr, name, type) \
    DECLARE_PEM_write_cb_bio_attr(attr, name, type) \
    DECLARE_PEM_write_cb_fp_attr(attr, name, type)
#define DECLARE_PEM_write_cb_ex_attr(attr, name, type) \
    DECLARE_PEM_write_cb_bio_ex_attr(attr, name, type) \
    DECLARE_PEM_write_cb_fp_ex_attr(attr, name, type)
#define DECLARE_PEM_write_cb(name, type) \
    DECLARE_PEM_write_cb_attr(extern, name, type)
#define DECLARE_PEM_write_cb_ex(name, type) \
    DECLARE_PEM_write_cb_ex_attr(extern, name, type)
#define DECLARE_PEM_read_attr(attr, name, type) \
    DECLARE_PEM_read_bio_attr(attr, name, type) \
    DECLARE_PEM_read_fp_attr(attr, name, type)
#define DECLARE_PEM_read_ex_attr(attr, name, type) \
    DECLARE_PEM_read_bio_ex_attr(attr, name, type) \
    DECLARE_PEM_read_fp_ex_attr(attr, name, type)
#define DECLARE_PEM_read(name, type) \
    DECLARE_PEM_read_attr(extern, name, type)
#define DECLARE_PEM_read_ex(name, type) \
    DECLARE_PEM_read_ex_attr(extern, name, type)
#define DECLARE_PEM_rw_attr(attr, name, type) \
    DECLARE_PEM_read_attr(attr, name, type)   \
    DECLARE_PEM_write_attr(attr, name, type)
#define DECLARE_PEM_rw_ex_attr(attr, name, type) \
    DECLARE_PEM_read_ex_attr(attr, name, type)   \
    DECLARE_PEM_write_ex_attr(attr, name, type)
#define DECLARE_PEM_rw(name, type) \
    DECLARE_PEM_rw_attr(extern, name, type)
#define DECLARE_PEM_rw_ex(name, type) \
    DECLARE_PEM_rw_ex_attr(extern, name, type)
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define DECLARE_PEM_rw_const_attr(attr, name, type) \
    DECLARE_PEM_read_attr(attr, name, type)         \
    DECLARE_PEM_write_const_attr(attr, name, type)
#define DECLARE_PEM_rw_const(name, type) \
    DECLARE_PEM_rw_const_attr(extern, name, type)
#endif
#define DECLARE_PEM_rw_cb_attr(attr, name, type) \
    DECLARE_PEM_read_attr(attr, name, type)      \
    DECLARE_PEM_write_cb_attr(attr, name, type)
#define DECLARE_PEM_rw_cb_ex_attr(attr, name, type) \
    DECLARE_PEM_read_ex_attr(attr, name, type)      \
    DECLARE_PEM_write_cb_ex_attr(attr, name, type)
#define DECLARE_PEM_rw_cb(name, type) \
    DECLARE_PEM_rw_cb_attr(extern, name, type)
#define DECLARE_PEM_rw_cb_ex(name, type) \
    DECLARE_PEM_rw_cb_ex_attr(extern, name, type)

int PEM_get_EVP_CIPHER_INFO(char *header, EVP_CIPHER_INFO *cipher);
int PEM_do_header(EVP_CIPHER_INFO *cipher, unsigned char *data, long *len,
    pem_password_cb *callback, void *u);

int PEM_read_bio(BIO *bp, char **name, char **header,
    unsigned char **data, long *len);
#define PEM_FLAG_SECURE 0x1
#define PEM_FLAG_EAY_COMPATIBLE 0x2
#define PEM_FLAG_ONLY_B64 0x4
int PEM_read_bio_ex(BIO *bp, char **name, char **header,
    unsigned char **data, long *len, unsigned int flags);
int PEM_bytes_read_bio_secmem(unsigned char **pdata, long *plen, char **pnm,
    const char *name, BIO *bp, pem_password_cb *cb,
    void *u);
int PEM_write_bio(BIO *bp, const char *name, const char *hdr,
    const unsigned char *data, long len);
int PEM_bytes_read_bio(unsigned char **pdata, long *plen, char **pnm,
    const char *name, BIO *bp, pem_password_cb *cb,
    void *u);
void *PEM_ASN1_read_bio(d2i_of_void *d2i, const char *name, BIO *bp, void **x,
    pem_password_cb *cb, void *u);
int PEM_ASN1_write_bio(i2d_of_void *i2d, const char *name, BIO *bp,
    const void *x, const EVP_CIPHER *enc,
    const unsigned char *kstr, int klen,
    pem_password_cb *cb, void *u);
int PEM_ASN1_write_bio_ctx(OSSL_i2d_of_void_ctx *i2d, void *vctx,
    const char *name, BIO *bp, const void *x,
    const EVP_CIPHER *enc, const unsigned char *kstr,
    int klen, pem_password_cb *cb, void *u);

STACK_OF(X509_INFO) *PEM_X509_INFO_read_bio(BIO *bp, STACK_OF(X509_INFO) *sk,
    pem_password_cb *cb, void *u);
STACK_OF(X509_INFO)
*PEM_X509_INFO_read_bio_ex(BIO *bp, STACK_OF(X509_INFO) *sk,
    pem_password_cb *cb, void *u, OSSL_LIB_CTX *libctx,
    const char *propq);

int PEM_X509_INFO_write_bio(BIO *bp, const X509_INFO *xi, EVP_CIPHER *enc,
    const unsigned char *kstr, int klen,
    pem_password_cb *cd, void *u);

#ifndef OPENSSL_NO_STDIO
int PEM_read(FILE *fp, char **name, char **header,
    unsigned char **data, long *len);
int PEM_write(FILE *fp, const char *name, const char *hdr,
    const unsigned char *data, long len);
void *PEM_ASN1_read(d2i_of_void *d2i, const char *name, FILE *fp, void **x,
    pem_password_cb *cb, void *u);
int PEM_ASN1_write(i2d_of_void *i2d, const char *name, FILE *fp,
    const void *x, const EVP_CIPHER *enc,
    const unsigned char *kstr, int klen,
    pem_password_cb *callback, void *u);
STACK_OF(X509_INFO) *PEM_X509_INFO_read(FILE *fp, STACK_OF(X509_INFO) *sk,
    pem_password_cb *cb, void *u);
STACK_OF(X509_INFO)
*PEM_X509_INFO_read_ex(FILE *fp, STACK_OF(X509_INFO) *sk, pem_password_cb *cb,
    void *u, OSSL_LIB_CTX *libctx, const char *propq);
#endif

int PEM_SignInit(EVP_MD_CTX *ctx, EVP_MD *type);
int PEM_SignUpdate(EVP_MD_CTX *ctx, const unsigned char *d, unsigned int cnt);
int PEM_SignFinal(EVP_MD_CTX *ctx, unsigned char *sigret,
    unsigned int *siglen, EVP_PKEY *pkey);

/* The default pem_password_cb that's used internally */
int PEM_def_callback(char *buf, int num, int rwflag, void *userdata);
void PEM_proc_type(char *buf, int type);
void PEM_dek_info(char *buf, const char *type, int len, const char *str);

#include <openssl/symhacks.h>

DECLARE_PEM_rw(X509, X509)
DECLARE_PEM_rw(X509_AUX, X509)
DECLARE_PEM_rw(X509_REQ, X509_REQ)
DECLARE_PEM_write(X509_REQ_NEW, X509_REQ)
DECLARE_PEM_rw(X509_CRL, X509_CRL)
DECLARE_PEM_rw(X509_PUBKEY, X509_PUBKEY)
DECLARE_PEM_rw(PKCS7, PKCS7)
DECLARE_PEM_rw(NETSCAPE_CERT_SEQUENCE, NETSCAPE_CERT_SEQUENCE)
DECLARE_PEM_rw(PKCS8, X509_SIG)
DECLARE_PEM_rw(PKCS8_PRIV_KEY_INFO, PKCS8_PRIV_KEY_INFO)
#ifndef OPENSSL_NO_DEPRECATED_3_0
DECLARE_PEM_rw_cb_attr(OSSL_DEPRECATEDIN_3_0, RSAPrivateKey, RSA)
DECLARE_PEM_rw_attr(OSSL_DEPRECATEDIN_3_0, RSAPublicKey, RSA)
DECLARE_PEM_rw_attr(OSSL_DEPRECATEDIN_3_0, RSA_PUBKEY, RSA)
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
#ifndef OPENSSL_NO_DSA
DECLARE_PEM_rw_cb_attr(OSSL_DEPRECATEDIN_3_0, DSAPrivateKey, DSA)
DECLARE_PEM_rw_attr(OSSL_DEPRECATEDIN_3_0, DSA_PUBKEY, DSA)
DECLARE_PEM_rw_attr(OSSL_DEPRECATEDIN_3_0, DSAparams, DSA)
#endif
#endif

#ifndef OPENSSL_NO_DEPRECATED_3_0
#ifndef OPENSSL_NO_EC
DECLARE_PEM_rw_attr(OSSL_DEPRECATEDIN_3_0, ECPKParameters, EC_GROUP)
DECLARE_PEM_rw_cb_attr(OSSL_DEPRECATEDIN_3_0, ECPrivateKey, EC_KEY)
DECLARE_PEM_rw_attr(OSSL_DEPRECATEDIN_3_0, EC_PUBKEY, EC_KEY)
#endif
#endif

#ifndef OPENSSL_NO_DH
#ifndef OPENSSL_NO_DEPRECATED_3_0
DECLARE_PEM_rw_attr(OSSL_DEPRECATEDIN_3_0, DHparams, DH)
DECLARE_PEM_write_attr(OSSL_DEPRECATEDIN_3_0, DHxparams, DH)
#endif
#endif
DECLARE_PEM_rw_cb_ex(PrivateKey, EVP_PKEY)
DECLARE_PEM_rw_ex(PUBKEY, EVP_PKEY)

int PEM_write_bio_PrivateKey_traditional(BIO *bp, const EVP_PKEY *x,
    const EVP_CIPHER *enc,
    const unsigned char *kstr, int klen,
    pem_password_cb *cb, void *u);

/* Why do these take a signed char *kstr? */
int PEM_write_bio_PKCS8PrivateKey_nid(BIO *bp, const EVP_PKEY *x, int nid,
    const char *kstr, int klen,
    pem_password_cb *cb, void *u);
int PEM_write_bio_PKCS8PrivateKey(BIO *, const EVP_PKEY *, const EVP_CIPHER *,
    const char *kstr, int klen,
    pem_password_cb *cb, void *u);
int i2d_PKCS8PrivateKey_bio(BIO *bp, const EVP_PKEY *x, const EVP_CIPHER *enc,
    const char *kstr, int klen,
    pem_password_cb *cb, void *u);
int i2d_PKCS8PrivateKey_nid_bio(BIO *bp, const EVP_PKEY *x, int nid,
    const char *kstr, int klen,
    pem_password_cb *cb, void *u);
EVP_PKEY *d2i_PKCS8PrivateKey_bio(BIO *bp, EVP_PKEY **x, pem_password_cb *cb,
    void *u);

#ifndef OPENSSL_NO_STDIO
int i2d_PKCS8PrivateKey_fp(FILE *fp, const EVP_PKEY *x, const EVP_CIPHER *enc,
    const char *kstr, int klen,
    pem_password_cb *cb, void *u);
int i2d_PKCS8PrivateKey_nid_fp(FILE *fp, const EVP_PKEY *x, int nid,
    const char *kstr, int klen,
    pem_password_cb *cb, void *u);
int PEM_write_PKCS8PrivateKey_nid(FILE *fp, const EVP_PKEY *x, int nid,
    const char *kstr, int klen,
    pem_password_cb *cb, void *u);

EVP_PKEY *d2i_PKCS8PrivateKey_fp(FILE *fp, EVP_PKEY **x, pem_password_cb *cb,
    void *u);

int PEM_write_PKCS8PrivateKey(FILE *fp, const EVP_PKEY *x, const EVP_CIPHER *enc,
    const char *kstr, int klen,
    pem_password_cb *cd, void *u);
#endif
EVP_PKEY *PEM_read_bio_Parameters_ex(BIO *bp, EVP_PKEY **x,
    OSSL_LIB_CTX *libctx, const char *propq);
EVP_PKEY *PEM_read_bio_Parameters(BIO *bp, EVP_PKEY **x);
int PEM_write_bio_Parameters(BIO *bp, const EVP_PKEY *x);

EVP_PKEY *b2i_PrivateKey(const unsigned char **in, long length);
EVP_PKEY *b2i_PublicKey(const unsigned char **in, long length);
EVP_PKEY *b2i_PrivateKey_bio(BIO *in);
EVP_PKEY *b2i_PublicKey_bio(BIO *in);
int i2b_PrivateKey_bio(BIO *out, const EVP_PKEY *pk);
int i2b_PublicKey_bio(BIO *out, const EVP_PKEY *pk);
EVP_PKEY *b2i_PVK_bio(BIO *in, pem_password_cb *cb, void *u);
EVP_PKEY *b2i_PVK_bio_ex(BIO *in, pem_password_cb *cb, void *u,
    OSSL_LIB_CTX *libctx, const char *propq);
int i2b_PVK_bio(BIO *out, const EVP_PKEY *pk, int enclevel,
    pem_password_cb *cb, void *u);
int i2b_PVK_bio_ex(BIO *out, const EVP_PKEY *pk, int enclevel,
    pem_password_cb *cb, void *u,
    OSSL_LIB_CTX *libctx, const char *propq);

#ifdef __cplusplus
}
#endif
#endif
