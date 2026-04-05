/*
 * Copyright 2006-2024 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_TS_H
#define OPENSSL_TS_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_TS_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_TS
#include <openssl/symhacks.h>
#include <openssl/buffer.h>
#include <openssl/evp.h>
#include <openssl/bio.h>
#include <openssl/asn1.h>
#include <openssl/safestack.h>
#include <openssl/rsa.h>
#include <openssl/dsa.h>
#include <openssl/dh.h>
#include <openssl/tserr.h>
#include <openssl/ess.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#ifndef OPENSSL_NO_STDIO
#include <stdio.h>
#endif
#ifdef __cplusplus
extern "C" {
#endif

typedef struct TS_msg_imprint_st TS_MSG_IMPRINT;
typedef struct TS_req_st TS_REQ;
typedef struct TS_accuracy_st TS_ACCURACY;
typedef struct TS_tst_info_st TS_TST_INFO;

/* Possible values for status. */
#define TS_STATUS_GRANTED 0
#define TS_STATUS_GRANTED_WITH_MODS 1
#define TS_STATUS_REJECTION 2
#define TS_STATUS_WAITING 3
#define TS_STATUS_REVOCATION_WARNING 4
#define TS_STATUS_REVOCATION_NOTIFICATION 5

/* Possible values for failure_info. */
#define TS_INFO_BAD_ALG 0
#define TS_INFO_BAD_REQUEST 2
#define TS_INFO_BAD_DATA_FORMAT 5
#define TS_INFO_TIME_NOT_AVAILABLE 14
#define TS_INFO_UNACCEPTED_POLICY 15
#define TS_INFO_UNACCEPTED_EXTENSION 16
#define TS_INFO_ADD_INFO_NOT_AVAILABLE 17
#define TS_INFO_SYSTEM_FAILURE 25

typedef struct TS_status_info_st TS_STATUS_INFO;

typedef struct TS_resp_st TS_RESP;

DECLARE_ASN1_ALLOC_FUNCTIONS(TS_REQ)
DECLARE_ASN1_ENCODE_FUNCTIONS_only(TS_REQ, TS_REQ)
DECLARE_ASN1_DUP_FUNCTION(TS_REQ)

#ifndef OPENSSL_NO_STDIO
TS_REQ *d2i_TS_REQ_fp(FILE *fp, TS_REQ **a);
int i2d_TS_REQ_fp(FILE *fp, const TS_REQ *a);
#endif
TS_REQ *d2i_TS_REQ_bio(BIO *fp, TS_REQ **a);
int i2d_TS_REQ_bio(BIO *fp, const TS_REQ *a);

DECLARE_ASN1_ALLOC_FUNCTIONS(TS_MSG_IMPRINT)
DECLARE_ASN1_ENCODE_FUNCTIONS_only(TS_MSG_IMPRINT, TS_MSG_IMPRINT)
DECLARE_ASN1_DUP_FUNCTION(TS_MSG_IMPRINT)

#ifndef OPENSSL_NO_STDIO
TS_MSG_IMPRINT *d2i_TS_MSG_IMPRINT_fp(FILE *fp, TS_MSG_IMPRINT **a);
int i2d_TS_MSG_IMPRINT_fp(FILE *fp, const TS_MSG_IMPRINT *a);
#endif
TS_MSG_IMPRINT *d2i_TS_MSG_IMPRINT_bio(BIO *bio, TS_MSG_IMPRINT **a);
int i2d_TS_MSG_IMPRINT_bio(BIO *bio, const TS_MSG_IMPRINT *a);

DECLARE_ASN1_ALLOC_FUNCTIONS(TS_RESP)
DECLARE_ASN1_ENCODE_FUNCTIONS_only(TS_RESP, TS_RESP)
DECLARE_ASN1_DUP_FUNCTION(TS_RESP)

#ifndef OPENSSL_NO_STDIO
TS_RESP *d2i_TS_RESP_fp(FILE *fp, TS_RESP **a);
int i2d_TS_RESP_fp(FILE *fp, const TS_RESP *a);
#endif
TS_RESP *d2i_TS_RESP_bio(BIO *bio, TS_RESP **a);
int i2d_TS_RESP_bio(BIO *bio, const TS_RESP *a);

DECLARE_ASN1_ALLOC_FUNCTIONS(TS_STATUS_INFO)
DECLARE_ASN1_ENCODE_FUNCTIONS_only(TS_STATUS_INFO, TS_STATUS_INFO)
DECLARE_ASN1_DUP_FUNCTION(TS_STATUS_INFO)

DECLARE_ASN1_ALLOC_FUNCTIONS(TS_TST_INFO)
DECLARE_ASN1_ENCODE_FUNCTIONS_only(TS_TST_INFO, TS_TST_INFO)
DECLARE_ASN1_DUP_FUNCTION(TS_TST_INFO)
TS_TST_INFO *PKCS7_to_TS_TST_INFO(PKCS7 *token);

#ifndef OPENSSL_NO_STDIO
TS_TST_INFO *d2i_TS_TST_INFO_fp(FILE *fp, TS_TST_INFO **a);
int i2d_TS_TST_INFO_fp(FILE *fp, const TS_TST_INFO *a);
#endif
TS_TST_INFO *d2i_TS_TST_INFO_bio(BIO *bio, TS_TST_INFO **a);
int i2d_TS_TST_INFO_bio(BIO *bio, const TS_TST_INFO *a);

DECLARE_ASN1_ALLOC_FUNCTIONS(TS_ACCURACY)
DECLARE_ASN1_ENCODE_FUNCTIONS_only(TS_ACCURACY, TS_ACCURACY)
DECLARE_ASN1_DUP_FUNCTION(TS_ACCURACY)

int TS_REQ_set_version(TS_REQ *a, long version);
long TS_REQ_get_version(const TS_REQ *a);

int TS_STATUS_INFO_set_status(TS_STATUS_INFO *a, int i);
const ASN1_INTEGER *TS_STATUS_INFO_get0_status(const TS_STATUS_INFO *a);

const STACK_OF(ASN1_UTF8STRING) *
TS_STATUS_INFO_get0_text(const TS_STATUS_INFO *a);

const ASN1_BIT_STRING *
TS_STATUS_INFO_get0_failure_info(const TS_STATUS_INFO *a);

int TS_REQ_set_msg_imprint(TS_REQ *a, TS_MSG_IMPRINT *msg_imprint);
TS_MSG_IMPRINT *TS_REQ_get_msg_imprint(TS_REQ *a);

int TS_MSG_IMPRINT_set_algo(TS_MSG_IMPRINT *a, X509_ALGOR *alg);
X509_ALGOR *TS_MSG_IMPRINT_get_algo(TS_MSG_IMPRINT *a);

int TS_MSG_IMPRINT_set_msg(TS_MSG_IMPRINT *a, unsigned char *d, int len);
ASN1_OCTET_STRING *TS_MSG_IMPRINT_get_msg(TS_MSG_IMPRINT *a);

int TS_REQ_set_policy_id(TS_REQ *a, const ASN1_OBJECT *policy);
ASN1_OBJECT *TS_REQ_get_policy_id(TS_REQ *a);

int TS_REQ_set_nonce(TS_REQ *a, const ASN1_INTEGER *nonce);
const ASN1_INTEGER *TS_REQ_get_nonce(const TS_REQ *a);

int TS_REQ_set_cert_req(TS_REQ *a, int cert_req);
int TS_REQ_get_cert_req(const TS_REQ *a);

STACK_OF(X509_EXTENSION) *TS_REQ_get_exts(TS_REQ *a);
void TS_REQ_ext_free(TS_REQ *a);
int TS_REQ_get_ext_count(TS_REQ *a);
int TS_REQ_get_ext_by_NID(TS_REQ *a, int nid, int lastpos);
int TS_REQ_get_ext_by_OBJ(TS_REQ *a, const ASN1_OBJECT *obj, int lastpos);
int TS_REQ_get_ext_by_critical(TS_REQ *a, int crit, int lastpos);
X509_EXTENSION *TS_REQ_get_ext(TS_REQ *a, int loc);
X509_EXTENSION *TS_REQ_delete_ext(TS_REQ *a, int loc);
int TS_REQ_add_ext(TS_REQ *a, X509_EXTENSION *ex, int loc);
void *TS_REQ_get_ext_d2i(TS_REQ *a, int nid, int *crit, int *idx);

/* Function declarations for TS_REQ defined in ts/ts_req_print.c */

int TS_REQ_print_bio(BIO *bio, TS_REQ *a);

/* Function declarations for TS_RESP defined in ts/ts_resp_utils.c */

int TS_RESP_set_status_info(TS_RESP *a, TS_STATUS_INFO *info);
TS_STATUS_INFO *TS_RESP_get_status_info(TS_RESP *a);

/* Caller loses ownership of PKCS7 and TS_TST_INFO objects. */
void TS_RESP_set_tst_info(TS_RESP *a, PKCS7 *p7, TS_TST_INFO *tst_info);
PKCS7 *TS_RESP_get_token(TS_RESP *a);
TS_TST_INFO *TS_RESP_get_tst_info(TS_RESP *a);

int TS_TST_INFO_set_version(TS_TST_INFO *a, long version);
long TS_TST_INFO_get_version(const TS_TST_INFO *a);

int TS_TST_INFO_set_policy_id(TS_TST_INFO *a, ASN1_OBJECT *policy_id);
ASN1_OBJECT *TS_TST_INFO_get_policy_id(TS_TST_INFO *a);

int TS_TST_INFO_set_msg_imprint(TS_TST_INFO *a, TS_MSG_IMPRINT *msg_imprint);
TS_MSG_IMPRINT *TS_TST_INFO_get_msg_imprint(TS_TST_INFO *a);

int TS_TST_INFO_set_serial(TS_TST_INFO *a, const ASN1_INTEGER *serial);
const ASN1_INTEGER *TS_TST_INFO_get_serial(const TS_TST_INFO *a);

int TS_TST_INFO_set_time(TS_TST_INFO *a, const ASN1_GENERALIZEDTIME *gtime);
const ASN1_GENERALIZEDTIME *TS_TST_INFO_get_time(const TS_TST_INFO *a);

int TS_TST_INFO_set_accuracy(TS_TST_INFO *a, TS_ACCURACY *accuracy);
TS_ACCURACY *TS_TST_INFO_get_accuracy(TS_TST_INFO *a);

int TS_ACCURACY_set_seconds(TS_ACCURACY *a, const ASN1_INTEGER *seconds);
const ASN1_INTEGER *TS_ACCURACY_get_seconds(const TS_ACCURACY *a);

int TS_ACCURACY_set_millis(TS_ACCURACY *a, const ASN1_INTEGER *millis);
const ASN1_INTEGER *TS_ACCURACY_get_millis(const TS_ACCURACY *a);

int TS_ACCURACY_set_micros(TS_ACCURACY *a, const ASN1_INTEGER *micros);
const ASN1_INTEGER *TS_ACCURACY_get_micros(const TS_ACCURACY *a);

int TS_TST_INFO_set_ordering(TS_TST_INFO *a, int ordering);
int TS_TST_INFO_get_ordering(const TS_TST_INFO *a);

int TS_TST_INFO_set_nonce(TS_TST_INFO *a, const ASN1_INTEGER *nonce);
const ASN1_INTEGER *TS_TST_INFO_get_nonce(const TS_TST_INFO *a);

int TS_TST_INFO_set_tsa(TS_TST_INFO *a, GENERAL_NAME *tsa);
GENERAL_NAME *TS_TST_INFO_get_tsa(TS_TST_INFO *a);

STACK_OF(X509_EXTENSION) *TS_TST_INFO_get_exts(TS_TST_INFO *a);
void TS_TST_INFO_ext_free(TS_TST_INFO *a);
int TS_TST_INFO_get_ext_count(TS_TST_INFO *a);
int TS_TST_INFO_get_ext_by_NID(TS_TST_INFO *a, int nid, int lastpos);
int TS_TST_INFO_get_ext_by_OBJ(TS_TST_INFO *a, const ASN1_OBJECT *obj,
    int lastpos);
int TS_TST_INFO_get_ext_by_critical(TS_TST_INFO *a, int crit, int lastpos);
X509_EXTENSION *TS_TST_INFO_get_ext(TS_TST_INFO *a, int loc);
X509_EXTENSION *TS_TST_INFO_delete_ext(TS_TST_INFO *a, int loc);
int TS_TST_INFO_add_ext(TS_TST_INFO *a, X509_EXTENSION *ex, int loc);
void *TS_TST_INFO_get_ext_d2i(TS_TST_INFO *a, int nid, int *crit, int *idx);

/*
 * Declarations related to response generation, defined in ts/ts_resp_sign.c.
 */

/* Optional flags for response generation. */

/* Don't include the TSA name in response. */
#define TS_TSA_NAME 0x01

/* Set ordering to true in response. */
#define TS_ORDERING 0x02

/*
 * Include the signer certificate and the other specified certificates in
 * the ESS signing certificate attribute beside the PKCS7 signed data.
 * Only the signer certificates is included by default.
 */
#define TS_ESS_CERT_ID_CHAIN 0x04

/* Forward declaration. */
struct TS_resp_ctx;

/* This must return a unique number less than 160 bits long. */
typedef ASN1_INTEGER *(*TS_serial_cb)(struct TS_resp_ctx *, void *);

/*
 * This must return the seconds and microseconds since Jan 1, 1970 in the sec
 * and usec variables allocated by the caller. Return non-zero for success
 * and zero for failure.
 */
typedef int (*TS_time_cb)(struct TS_resp_ctx *, void *, long *sec,
    long *usec);

/*
 * This must process the given extension. It can modify the TS_TST_INFO
 * object of the context. Return values: !0 (processed), 0 (error, it must
 * set the status info/failure info of the response).
 */
typedef int (*TS_extension_cb)(struct TS_resp_ctx *, X509_EXTENSION *,
    void *);

typedef struct TS_resp_ctx TS_RESP_CTX;

/* Creates a response context that can be used for generating responses. */
TS_RESP_CTX *TS_RESP_CTX_new(void);
TS_RESP_CTX *TS_RESP_CTX_new_ex(OSSL_LIB_CTX *libctx, const char *propq);
void TS_RESP_CTX_free(TS_RESP_CTX *ctx);

/* This parameter must be set. */
int TS_RESP_CTX_set_signer_cert(TS_RESP_CTX *ctx, X509 *signer);

/* This parameter must be set. */
int TS_RESP_CTX_set_signer_key(TS_RESP_CTX *ctx, EVP_PKEY *key);

int TS_RESP_CTX_set_signer_digest(TS_RESP_CTX *ctx,
    const EVP_MD *signer_digest);
int TS_RESP_CTX_set_ess_cert_id_digest(TS_RESP_CTX *ctx, const EVP_MD *md);

/* This parameter must be set. */
int TS_RESP_CTX_set_def_policy(TS_RESP_CTX *ctx, const ASN1_OBJECT *def_policy);

/* No additional certs are included in the response by default. */
int TS_RESP_CTX_set_certs(TS_RESP_CTX *ctx, STACK_OF(X509) *certs);

/*
 * Adds a new acceptable policy, only the default policy is accepted by
 * default.
 */
int TS_RESP_CTX_add_policy(TS_RESP_CTX *ctx, const ASN1_OBJECT *policy);

/*
 * Adds a new acceptable message digest. Note that no message digests are
 * accepted by default. The md argument is shared with the caller.
 */
int TS_RESP_CTX_add_md(TS_RESP_CTX *ctx, const EVP_MD *md);

/* Accuracy is not included by default. */
int TS_RESP_CTX_set_accuracy(TS_RESP_CTX *ctx,
    int secs, int millis, int micros);

/*
 * Clock precision digits, i.e. the number of decimal digits: '0' means sec,
 * '3' msec, '6' usec, and so on. Default is 0.
 */
int TS_RESP_CTX_set_clock_precision_digits(TS_RESP_CTX *ctx,
    unsigned clock_precision_digits);
/* At most we accept usec precision. */
#define TS_MAX_CLOCK_PRECISION_DIGITS 6

/* Maximum status message length */
#define TS_MAX_STATUS_LENGTH (1024 * 1024)

/* No flags are set by default. */
void TS_RESP_CTX_add_flags(TS_RESP_CTX *ctx, int flags);

/* Default callback always returns a constant. */
void TS_RESP_CTX_set_serial_cb(TS_RESP_CTX *ctx, TS_serial_cb cb, void *data);

/* Default callback uses the gettimeofday() and gmtime() system calls. */
void TS_RESP_CTX_set_time_cb(TS_RESP_CTX *ctx, TS_time_cb cb, void *data);

/*
 * Default callback rejects all extensions. The extension callback is called
 * when the TS_TST_INFO object is already set up and not signed yet.
 */
/* FIXME: extension handling is not tested yet. */
void TS_RESP_CTX_set_extension_cb(TS_RESP_CTX *ctx,
    TS_extension_cb cb, void *data);

/* The following methods can be used in the callbacks. */
int TS_RESP_CTX_set_status_info(TS_RESP_CTX *ctx,
    int status, const char *text);

/* Sets the status info only if it is still TS_STATUS_GRANTED. */
int TS_RESP_CTX_set_status_info_cond(TS_RESP_CTX *ctx,
    int status, const char *text);

int TS_RESP_CTX_add_failure_info(TS_RESP_CTX *ctx, int failure);

/* The get methods below can be used in the extension callback. */
TS_REQ *TS_RESP_CTX_get_request(TS_RESP_CTX *ctx);

TS_TST_INFO *TS_RESP_CTX_get_tst_info(TS_RESP_CTX *ctx);

/*
 * Creates the signed TS_TST_INFO and puts it in TS_RESP.
 * In case of errors it sets the status info properly.
 * Returns NULL only in case of memory allocation/fatal error.
 */
TS_RESP *TS_RESP_create_response(TS_RESP_CTX *ctx, BIO *req_bio);

/*
 * Declarations related to response verification,
 * they are defined in ts/ts_resp_verify.c.
 */

int TS_RESP_verify_signature(PKCS7 *token, STACK_OF(X509) *certs,
    X509_STORE *store, X509 **signer_out);

/* Context structure for the generic verify method. */

/* Verify the signer's certificate and the signature of the response. */
#define TS_VFY_SIGNATURE (1u << 0)
/* Verify the version number of the response. */
#define TS_VFY_VERSION (1u << 1)
/* Verify if the policy supplied by the user matches the policy of the TSA. */
#define TS_VFY_POLICY (1u << 2)
/*
 * Verify the message imprint provided by the user. This flag should not be
 * specified with TS_VFY_DATA.
 */
#define TS_VFY_IMPRINT (1u << 3)
/*
 * Verify the message imprint computed by the verify method from the user
 * provided data and the MD algorithm of the response. This flag should not
 * be specified with TS_VFY_IMPRINT.
 */
#define TS_VFY_DATA (1u << 4)
/* Verify the nonce value. */
#define TS_VFY_NONCE (1u << 5)
/* Verify if the TSA name field matches the signer certificate. */
#define TS_VFY_SIGNER (1u << 6)
/* Verify if the TSA name field equals to the user provided name. */
#define TS_VFY_TSA_NAME (1u << 7)

/* You can use the following convenience constants. */
#define TS_VFY_ALL_IMPRINT (TS_VFY_SIGNATURE \
    | TS_VFY_VERSION                         \
    | TS_VFY_POLICY                          \
    | TS_VFY_IMPRINT                         \
    | TS_VFY_NONCE                           \
    | TS_VFY_SIGNER                          \
    | TS_VFY_TSA_NAME)
#define TS_VFY_ALL_DATA (TS_VFY_SIGNATURE \
    | TS_VFY_VERSION                      \
    | TS_VFY_POLICY                       \
    | TS_VFY_DATA                         \
    | TS_VFY_NONCE                        \
    | TS_VFY_SIGNER                       \
    | TS_VFY_TSA_NAME)

typedef struct TS_verify_ctx TS_VERIFY_CTX;

int TS_RESP_verify_response(TS_VERIFY_CTX *ctx, TS_RESP *response);
int TS_RESP_verify_token(TS_VERIFY_CTX *ctx, PKCS7 *token);

/*
 * Declarations related to response verification context,
 */
TS_VERIFY_CTX *TS_VERIFY_CTX_new(void);
void TS_VERIFY_CTX_init(TS_VERIFY_CTX *ctx);
void TS_VERIFY_CTX_free(TS_VERIFY_CTX *ctx);
void TS_VERIFY_CTX_cleanup(TS_VERIFY_CTX *ctx);
int TS_VERIFY_CTX_set_flags(TS_VERIFY_CTX *ctx, int f);
int TS_VERIFY_CTX_add_flags(TS_VERIFY_CTX *ctx, int f);
#ifndef OPENSSL_NO_DEPRECATED_3_4
OSSL_DEPRECATEDIN_3_4_FOR("Unclear semantics, replace with TS_VERIFY_CTX_set0_data().")
BIO *TS_VERIFY_CTX_set_data(TS_VERIFY_CTX *ctx, BIO *b);
#endif
int TS_VERIFY_CTX_set0_data(TS_VERIFY_CTX *ctx, BIO *b);
#ifndef OPENSSL_NO_DEPRECATED_3_4
OSSL_DEPRECATEDIN_3_4_FOR("Unclear semantics, replace with TS_VERIFY_CTX_set0_imprint().")
unsigned char *TS_VERIFY_CTX_set_imprint(TS_VERIFY_CTX *ctx,
    unsigned char *hexstr, long len);
#endif
int TS_VERIFY_CTX_set0_imprint(TS_VERIFY_CTX *ctx,
    unsigned char *hexstr, long len);
#ifndef OPENSSL_NO_DEPRECATED_3_4
OSSL_DEPRECATEDIN_3_4_FOR("Unclear semantics, replace with TS_VERIFY_CTX_set0_store().")
X509_STORE *TS_VERIFY_CTX_set_store(TS_VERIFY_CTX *ctx, X509_STORE *s);
#endif
int TS_VERIFY_CTX_set0_store(TS_VERIFY_CTX *ctx, X509_STORE *s);
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define TS_VERIFY_CTS_set_certs(ctx, cert) TS_VERIFY_CTX_set_certs(ctx, cert)
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_4
OSSL_DEPRECATEDIN_3_4_FOR("Unclear semantics, replace with TS_VERIFY_CTX_set0_certs().")
STACK_OF(X509) *TS_VERIFY_CTX_set_certs(TS_VERIFY_CTX *ctx, STACK_OF(X509) *certs);
#endif
int TS_VERIFY_CTX_set0_certs(TS_VERIFY_CTX *ctx, STACK_OF(X509) *certs);

/*-
 * If ctx is NULL, it allocates and returns a new object, otherwise
 * it returns ctx. It initialises all the members as follows:
 * flags = TS_VFY_ALL_IMPRINT & ~(TS_VFY_TSA_NAME | TS_VFY_SIGNATURE)
 * certs = NULL
 * store = NULL
 * policy = policy from the request or NULL if absent (in this case
 *      TS_VFY_POLICY is cleared from flags as well)
 * md_alg = MD algorithm from request
 * imprint, imprint_len = imprint from request
 * data = NULL
 * nonce, nonce_len = nonce from the request or NULL if absent (in this case
 *      TS_VFY_NONCE is cleared from flags as well)
 * tsa_name = NULL
 * Important: after calling this method TS_VFY_SIGNATURE should be added!
 */
TS_VERIFY_CTX *TS_REQ_to_TS_VERIFY_CTX(TS_REQ *req, TS_VERIFY_CTX *ctx);

/* Function declarations for TS_RESP defined in ts/ts_resp_print.c */

int TS_RESP_print_bio(BIO *bio, TS_RESP *a);
int TS_STATUS_INFO_print_bio(BIO *bio, TS_STATUS_INFO *a);
int TS_TST_INFO_print_bio(BIO *bio, TS_TST_INFO *a);

/* Common utility functions defined in ts/ts_lib.c */

int TS_ASN1_INTEGER_print_bio(BIO *bio, const ASN1_INTEGER *num);
int TS_OBJ_print_bio(BIO *bio, const ASN1_OBJECT *obj);
int TS_ext_print_bio(BIO *bio, const STACK_OF(X509_EXTENSION) *extensions);
int TS_X509_ALGOR_print_bio(BIO *bio, const X509_ALGOR *alg);
int TS_MSG_IMPRINT_print_bio(BIO *bio, TS_MSG_IMPRINT *msg);

/*
 * Function declarations for handling configuration options, defined in
 * ts/ts_conf.c
 */

X509 *TS_CONF_load_cert(const char *file);
STACK_OF(X509) *TS_CONF_load_certs(const char *file);
EVP_PKEY *TS_CONF_load_key(const char *file, const char *pass);
const char *TS_CONF_get_tsa_section(CONF *conf, const char *section);
int TS_CONF_set_serial(CONF *conf, const char *section, TS_serial_cb cb,
    TS_RESP_CTX *ctx);
#ifndef OPENSSL_NO_ENGINE
int TS_CONF_set_crypto_device(CONF *conf, const char *section,
    const char *device);
int TS_CONF_set_default_engine(const char *name);
#endif
int TS_CONF_set_signer_cert(CONF *conf, const char *section,
    const char *cert, TS_RESP_CTX *ctx);
int TS_CONF_set_certs(CONF *conf, const char *section, const char *certs,
    TS_RESP_CTX *ctx);
int TS_CONF_set_signer_key(CONF *conf, const char *section,
    const char *key, const char *pass,
    TS_RESP_CTX *ctx);
int TS_CONF_set_signer_digest(CONF *conf, const char *section,
    const char *md, TS_RESP_CTX *ctx);
int TS_CONF_set_def_policy(CONF *conf, const char *section,
    const char *policy, TS_RESP_CTX *ctx);
int TS_CONF_set_policies(CONF *conf, const char *section, TS_RESP_CTX *ctx);
int TS_CONF_set_digests(CONF *conf, const char *section, TS_RESP_CTX *ctx);
int TS_CONF_set_accuracy(CONF *conf, const char *section, TS_RESP_CTX *ctx);
int TS_CONF_set_clock_precision_digits(const CONF *conf, const char *section,
    TS_RESP_CTX *ctx);
int TS_CONF_set_ordering(CONF *conf, const char *section, TS_RESP_CTX *ctx);
int TS_CONF_set_tsa_name(CONF *conf, const char *section, TS_RESP_CTX *ctx);
int TS_CONF_set_ess_cert_id_chain(CONF *conf, const char *section,
    TS_RESP_CTX *ctx);
int TS_CONF_set_ess_cert_id_digest(CONF *conf, const char *section,
    TS_RESP_CTX *ctx);

#ifdef __cplusplus
}
#endif
#endif
#endif
