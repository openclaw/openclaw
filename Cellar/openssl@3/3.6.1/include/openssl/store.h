/*
 * Copyright 2016-2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_STORE_H
#define OPENSSL_STORE_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_OSSL_STORE_H
#endif

#include <stdarg.h>
#include <openssl/types.h>
#include <openssl/pem.h>
#include <openssl/storeerr.h>

#ifdef __cplusplus
extern "C" {
#endif

/*-
 *  The main OSSL_STORE functions.
 *  ------------------------------
 *
 *  These allow applications to open a channel to a resource with supported
 *  data (keys, certs, crls, ...), read the data a piece at a time and decide
 *  what to do with it, and finally close.
 */

typedef struct ossl_store_ctx_st OSSL_STORE_CTX;

/*
 * Typedef for the OSSL_STORE_INFO post processing callback.  This can be used
 * to massage the given OSSL_STORE_INFO, or to drop it entirely (by returning
 * NULL).
 */
typedef OSSL_STORE_INFO *(*OSSL_STORE_post_process_info_fn)(OSSL_STORE_INFO *,
    void *);

/*
 * Open a channel given a URI.  The given UI method will be used any time the
 * loader needs extra input, for example when a password or pin is needed, and
 * will be passed the same user data every time it's needed in this context.
 *
 * Returns a context reference which represents the channel to communicate
 * through.
 */
OSSL_STORE_CTX *
OSSL_STORE_open(const char *uri, const UI_METHOD *ui_method, void *ui_data,
    OSSL_STORE_post_process_info_fn post_process,
    void *post_process_data);
OSSL_STORE_CTX *
OSSL_STORE_open_ex(const char *uri, OSSL_LIB_CTX *libctx, const char *propq,
    const UI_METHOD *ui_method, void *ui_data,
    const OSSL_PARAM params[],
    OSSL_STORE_post_process_info_fn post_process,
    void *post_process_data);

/*
 * Control / fine tune the OSSL_STORE channel.  |cmd| determines what is to be
 * done, and depends on the underlying loader (use OSSL_STORE_get0_scheme to
 * determine which loader is used), except for common commands (see below).
 * Each command takes different arguments.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int OSSL_STORE_ctrl(OSSL_STORE_CTX *ctx, int cmd,
    ... /* args */);
OSSL_DEPRECATEDIN_3_0 int OSSL_STORE_vctrl(OSSL_STORE_CTX *ctx, int cmd,
    va_list args);
#endif

#ifndef OPENSSL_NO_DEPRECATED_3_0

/*
 * Common ctrl commands that different loaders may choose to support.
 */
/* int on = 0 or 1; STORE_ctrl(ctx, STORE_C_USE_SECMEM, &on); */
#define OSSL_STORE_C_USE_SECMEM 1
/* Where custom commands start */
#define OSSL_STORE_C_CUSTOM_START 100

#endif

/*
 * Read one data item (a key, a cert, a CRL) that is supported by the OSSL_STORE
 * functionality, given a context.
 * Returns a OSSL_STORE_INFO pointer, from which OpenSSL typed data can be
 * extracted with OSSL_STORE_INFO_get0_PKEY(), OSSL_STORE_INFO_get0_CERT(), ...
 * NULL is returned on error, which may include that the data found at the URI
 * can't be figured out for certain or is ambiguous.
 */
OSSL_STORE_INFO *OSSL_STORE_load(OSSL_STORE_CTX *ctx);

/*
 * Deletes the object in the store by URI.
 * Returns 1 on success, 0 otherwise.
 */
int OSSL_STORE_delete(const char *uri, OSSL_LIB_CTX *libctx, const char *propq,
    const UI_METHOD *ui_method, void *ui_data,
    const OSSL_PARAM params[]);

/*
 * Check if end of data (end of file) is reached
 * Returns 1 on end, 0 otherwise.
 */
int OSSL_STORE_eof(OSSL_STORE_CTX *ctx);

/*
 * Check if an error occurred
 * Returns 1 if it did, 0 otherwise.
 */
int OSSL_STORE_error(OSSL_STORE_CTX *ctx);

/*
 * Close the channel
 * Returns 1 on success, 0 on error.
 */
int OSSL_STORE_close(OSSL_STORE_CTX *ctx);

/*
 * Attach to a BIO.  This works like OSSL_STORE_open() except it takes a
 * BIO instead of a uri, along with a scheme to use when reading.
 * The given UI method will be used any time the loader needs extra input,
 * for example when a password or pin is needed, and will be passed the
 * same user data every time it's needed in this context.
 *
 * Returns a context reference which represents the channel to communicate
 * through.
 *
 * Note that this function is considered unsafe, all depending on what the
 * BIO actually reads.
 */
OSSL_STORE_CTX *OSSL_STORE_attach(BIO *bio, const char *scheme,
    OSSL_LIB_CTX *libctx, const char *propq,
    const UI_METHOD *ui_method, void *ui_data,
    const OSSL_PARAM params[],
    OSSL_STORE_post_process_info_fn post_process,
    void *post_process_data);

/*-
 *  Extracting OpenSSL types from and creating new OSSL_STORE_INFOs
 *  ---------------------------------------------------------------
 */

/*
 * Types of data that can be ossl_stored in a OSSL_STORE_INFO.
 * OSSL_STORE_INFO_NAME is typically found when getting a listing of
 * available "files" / "tokens" / what have you.
 */
#define OSSL_STORE_INFO_NAME 1 /* char * */
#define OSSL_STORE_INFO_PARAMS 2 /* EVP_PKEY * */
#define OSSL_STORE_INFO_PUBKEY 3 /* EVP_PKEY * */
#define OSSL_STORE_INFO_PKEY 4 /* EVP_PKEY * */
#define OSSL_STORE_INFO_CERT 5 /* X509 * */
#define OSSL_STORE_INFO_CRL 6 /* X509_CRL * */

/*
 * Functions to generate OSSL_STORE_INFOs, one function for each type we
 * support having in them, as well as a generic constructor.
 *
 * In all cases, ownership of the object is transferred to the OSSL_STORE_INFO
 * and will therefore be freed when the OSSL_STORE_INFO is freed.
 */
OSSL_STORE_INFO *OSSL_STORE_INFO_new(int type, void *data);
OSSL_STORE_INFO *OSSL_STORE_INFO_new_NAME(char *name);
int OSSL_STORE_INFO_set0_NAME_description(OSSL_STORE_INFO *info, char *desc);
OSSL_STORE_INFO *OSSL_STORE_INFO_new_PARAMS(EVP_PKEY *params);
OSSL_STORE_INFO *OSSL_STORE_INFO_new_PUBKEY(EVP_PKEY *pubkey);
OSSL_STORE_INFO *OSSL_STORE_INFO_new_PKEY(EVP_PKEY *pkey);
OSSL_STORE_INFO *OSSL_STORE_INFO_new_CERT(X509 *x509);
OSSL_STORE_INFO *OSSL_STORE_INFO_new_CRL(X509_CRL *crl);

/*
 * Functions to try to extract data from a OSSL_STORE_INFO.
 */
int OSSL_STORE_INFO_get_type(const OSSL_STORE_INFO *info);
void *OSSL_STORE_INFO_get0_data(int type, const OSSL_STORE_INFO *info);
const char *OSSL_STORE_INFO_get0_NAME(const OSSL_STORE_INFO *info);
char *OSSL_STORE_INFO_get1_NAME(const OSSL_STORE_INFO *info);
const char *OSSL_STORE_INFO_get0_NAME_description(const OSSL_STORE_INFO *info);
char *OSSL_STORE_INFO_get1_NAME_description(const OSSL_STORE_INFO *info);
EVP_PKEY *OSSL_STORE_INFO_get0_PARAMS(const OSSL_STORE_INFO *info);
EVP_PKEY *OSSL_STORE_INFO_get1_PARAMS(const OSSL_STORE_INFO *info);
EVP_PKEY *OSSL_STORE_INFO_get0_PUBKEY(const OSSL_STORE_INFO *info);
EVP_PKEY *OSSL_STORE_INFO_get1_PUBKEY(const OSSL_STORE_INFO *info);
EVP_PKEY *OSSL_STORE_INFO_get0_PKEY(const OSSL_STORE_INFO *info);
EVP_PKEY *OSSL_STORE_INFO_get1_PKEY(const OSSL_STORE_INFO *info);
X509 *OSSL_STORE_INFO_get0_CERT(const OSSL_STORE_INFO *info);
X509 *OSSL_STORE_INFO_get1_CERT(const OSSL_STORE_INFO *info);
X509_CRL *OSSL_STORE_INFO_get0_CRL(const OSSL_STORE_INFO *info);
X509_CRL *OSSL_STORE_INFO_get1_CRL(const OSSL_STORE_INFO *info);

const char *OSSL_STORE_INFO_type_string(int type);

/*
 * Free the OSSL_STORE_INFO
 */
void OSSL_STORE_INFO_free(OSSL_STORE_INFO *info);

/*-
 *  Functions to construct a search URI from a base URI and search criteria
 *  -----------------------------------------------------------------------
 */

/* OSSL_STORE search types */
#define OSSL_STORE_SEARCH_BY_NAME 1 /* subject in certs, issuer in CRLs */
#define OSSL_STORE_SEARCH_BY_ISSUER_SERIAL 2
#define OSSL_STORE_SEARCH_BY_KEY_FINGERPRINT 3
#define OSSL_STORE_SEARCH_BY_ALIAS 4

/* To check what search types the scheme handler supports */
int OSSL_STORE_supports_search(OSSL_STORE_CTX *ctx, int search_type);

/* Search term constructors */
/*
 * The input is considered to be owned by the caller, and must therefore
 * remain present throughout the lifetime of the returned OSSL_STORE_SEARCH
 */
OSSL_STORE_SEARCH *OSSL_STORE_SEARCH_by_name(X509_NAME *name);
OSSL_STORE_SEARCH *OSSL_STORE_SEARCH_by_issuer_serial(X509_NAME *name,
    const ASN1_INTEGER
        *serial);
OSSL_STORE_SEARCH *OSSL_STORE_SEARCH_by_key_fingerprint(const EVP_MD *digest,
    const unsigned char
        *bytes,
    size_t len);
OSSL_STORE_SEARCH *OSSL_STORE_SEARCH_by_alias(const char *alias);

/* Search term destructor */
void OSSL_STORE_SEARCH_free(OSSL_STORE_SEARCH *search);

/* Search term accessors */
int OSSL_STORE_SEARCH_get_type(const OSSL_STORE_SEARCH *criterion);
X509_NAME *OSSL_STORE_SEARCH_get0_name(const OSSL_STORE_SEARCH *criterion);
const ASN1_INTEGER *OSSL_STORE_SEARCH_get0_serial(const OSSL_STORE_SEARCH
        *criterion);
const unsigned char *OSSL_STORE_SEARCH_get0_bytes(const OSSL_STORE_SEARCH
                                                      *criterion,
    size_t *length);
const char *OSSL_STORE_SEARCH_get0_string(const OSSL_STORE_SEARCH *criterion);
const EVP_MD *OSSL_STORE_SEARCH_get0_digest(const OSSL_STORE_SEARCH *criterion);

/*
 * Add search criterion and expected return type (which can be unspecified)
 * to the loading channel.  This MUST happen before the first OSSL_STORE_load().
 */
int OSSL_STORE_expect(OSSL_STORE_CTX *ctx, int expected_type);
int OSSL_STORE_find(OSSL_STORE_CTX *ctx, const OSSL_STORE_SEARCH *search);

/*-
 *  Function to fetch a loader and extract data from it
 *  ---------------------------------------------------
 */

typedef struct ossl_store_loader_st OSSL_STORE_LOADER;

OSSL_STORE_LOADER *OSSL_STORE_LOADER_fetch(OSSL_LIB_CTX *libctx,
    const char *scheme,
    const char *properties);
int OSSL_STORE_LOADER_up_ref(OSSL_STORE_LOADER *loader);
void OSSL_STORE_LOADER_free(OSSL_STORE_LOADER *loader);
const OSSL_PROVIDER *OSSL_STORE_LOADER_get0_provider(const OSSL_STORE_LOADER *
        loader);
const char *OSSL_STORE_LOADER_get0_properties(const OSSL_STORE_LOADER *loader);
const char *OSSL_STORE_LOADER_get0_description(const OSSL_STORE_LOADER *loader);
int OSSL_STORE_LOADER_is_a(const OSSL_STORE_LOADER *loader,
    const char *scheme);
void OSSL_STORE_LOADER_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(OSSL_STORE_LOADER *loader,
        void *arg),
    void *arg);
int OSSL_STORE_LOADER_names_do_all(const OSSL_STORE_LOADER *loader,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PARAM *
OSSL_STORE_LOADER_settable_ctx_params(const OSSL_STORE_LOADER *loader);

/*-
 *  Function to register a loader for the given URI scheme.
 *  -------------------------------------------------------
 *
 *  The loader receives all the main components of an URI except for the
 *  scheme.
 */

#ifndef OPENSSL_NO_DEPRECATED_3_0

/* struct ossl_store_loader_ctx_st is defined differently by each loader */
typedef struct ossl_store_loader_ctx_st OSSL_STORE_LOADER_CTX;
typedef OSSL_STORE_LOADER_CTX *(*OSSL_STORE_open_fn)(const OSSL_STORE_LOADER *loader, const char *uri,
    const UI_METHOD *ui_method, void *ui_data);
typedef OSSL_STORE_LOADER_CTX *(*OSSL_STORE_open_ex_fn)(const OSSL_STORE_LOADER *loader,
    const char *uri, OSSL_LIB_CTX *libctx, const char *propq,
    const UI_METHOD *ui_method, void *ui_data);

typedef OSSL_STORE_LOADER_CTX *(*OSSL_STORE_attach_fn)(const OSSL_STORE_LOADER *loader, BIO *bio,
    OSSL_LIB_CTX *libctx, const char *propq,
    const UI_METHOD *ui_method, void *ui_data);
typedef int (*OSSL_STORE_ctrl_fn)(OSSL_STORE_LOADER_CTX *ctx, int cmd, va_list args);
typedef int (*OSSL_STORE_expect_fn)(OSSL_STORE_LOADER_CTX *ctx, int expected);
typedef int (*OSSL_STORE_find_fn)(OSSL_STORE_LOADER_CTX *ctx, const OSSL_STORE_SEARCH *criteria);
typedef OSSL_STORE_INFO *(*OSSL_STORE_load_fn)(OSSL_STORE_LOADER_CTX *ctx, const UI_METHOD *ui_method, void *ui_data);
typedef int (*OSSL_STORE_eof_fn)(OSSL_STORE_LOADER_CTX *ctx);
typedef int (*OSSL_STORE_error_fn)(OSSL_STORE_LOADER_CTX *ctx);
typedef int (*OSSL_STORE_close_fn)(OSSL_STORE_LOADER_CTX *ctx);

#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
OSSL_STORE_LOADER *OSSL_STORE_LOADER_new(ENGINE *e, const char *scheme);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_open(OSSL_STORE_LOADER *loader,
    OSSL_STORE_open_fn open_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_open_ex(OSSL_STORE_LOADER *loader,
    OSSL_STORE_open_ex_fn open_ex_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_attach(OSSL_STORE_LOADER *loader,
    OSSL_STORE_attach_fn attach_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_ctrl(OSSL_STORE_LOADER *loader,
    OSSL_STORE_ctrl_fn ctrl_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_expect(OSSL_STORE_LOADER *loader,
    OSSL_STORE_expect_fn expect_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_find(OSSL_STORE_LOADER *loader,
    OSSL_STORE_find_fn find_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_load(OSSL_STORE_LOADER *loader,
    OSSL_STORE_load_fn load_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_eof(OSSL_STORE_LOADER *loader,
    OSSL_STORE_eof_fn eof_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_error(OSSL_STORE_LOADER *loader,
    OSSL_STORE_error_fn error_function);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_LOADER_set_close(OSSL_STORE_LOADER *loader,
    OSSL_STORE_close_fn close_function);
OSSL_DEPRECATEDIN_3_0
const ENGINE *OSSL_STORE_LOADER_get0_engine(const OSSL_STORE_LOADER *loader);
OSSL_DEPRECATEDIN_3_0
const char *OSSL_STORE_LOADER_get0_scheme(const OSSL_STORE_LOADER *loader);
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_register_loader(OSSL_STORE_LOADER *loader);
OSSL_DEPRECATEDIN_3_0
OSSL_STORE_LOADER *OSSL_STORE_unregister_loader(const char *scheme);
#endif

/*-
 *  Functions to list STORE loaders
 *  -------------------------------
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
int OSSL_STORE_do_all_loaders(void (*do_function)(const OSSL_STORE_LOADER *loader,
                                  void *do_arg),
    void *do_arg);
#endif

#ifdef __cplusplus
}
#endif
#endif
