/*
 * Copyright 2020-2021 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_DECODER_H
#define OPENSSL_DECODER_H
#pragma once

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_STDIO
#include <stdio.h>
#endif
#include <stdarg.h>
#include <stddef.h>
#include <openssl/decodererr.h>
#include <openssl/types.h>
#include <openssl/core.h>

#ifdef __cplusplus
extern "C" {
#endif

OSSL_DECODER *OSSL_DECODER_fetch(OSSL_LIB_CTX *libctx, const char *name,
    const char *properties);
int OSSL_DECODER_up_ref(OSSL_DECODER *encoder);
void OSSL_DECODER_free(OSSL_DECODER *encoder);

const OSSL_PROVIDER *OSSL_DECODER_get0_provider(const OSSL_DECODER *encoder);
const char *OSSL_DECODER_get0_properties(const OSSL_DECODER *encoder);
const char *OSSL_DECODER_get0_name(const OSSL_DECODER *decoder);
const char *OSSL_DECODER_get0_description(const OSSL_DECODER *decoder);
int OSSL_DECODER_is_a(const OSSL_DECODER *encoder, const char *name);

void OSSL_DECODER_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(OSSL_DECODER *encoder, void *arg),
    void *arg);
int OSSL_DECODER_names_do_all(const OSSL_DECODER *encoder,
    void (*fn)(const char *name, void *data),
    void *data);
const OSSL_PARAM *OSSL_DECODER_gettable_params(OSSL_DECODER *decoder);
int OSSL_DECODER_get_params(OSSL_DECODER *decoder, OSSL_PARAM params[]);

const OSSL_PARAM *OSSL_DECODER_settable_ctx_params(OSSL_DECODER *encoder);
OSSL_DECODER_CTX *OSSL_DECODER_CTX_new(void);
int OSSL_DECODER_CTX_set_params(OSSL_DECODER_CTX *ctx,
    const OSSL_PARAM params[]);
void OSSL_DECODER_CTX_free(OSSL_DECODER_CTX *ctx);

/* Utilities that help set specific parameters */
int OSSL_DECODER_CTX_set_passphrase(OSSL_DECODER_CTX *ctx,
    const unsigned char *kstr, size_t klen);
int OSSL_DECODER_CTX_set_pem_password_cb(OSSL_DECODER_CTX *ctx,
    pem_password_cb *cb, void *cbarg);
int OSSL_DECODER_CTX_set_passphrase_cb(OSSL_DECODER_CTX *ctx,
    OSSL_PASSPHRASE_CALLBACK *cb,
    void *cbarg);
int OSSL_DECODER_CTX_set_passphrase_ui(OSSL_DECODER_CTX *ctx,
    const UI_METHOD *ui_method,
    void *ui_data);

/*
 * Utilities to read the object to decode, with the result sent to cb.
 * These will discover all provided methods
 */

int OSSL_DECODER_CTX_set_selection(OSSL_DECODER_CTX *ctx, int selection);
int OSSL_DECODER_CTX_set_input_type(OSSL_DECODER_CTX *ctx,
    const char *input_type);
int OSSL_DECODER_CTX_set_input_structure(OSSL_DECODER_CTX *ctx,
    const char *input_structure);
int OSSL_DECODER_CTX_add_decoder(OSSL_DECODER_CTX *ctx, OSSL_DECODER *decoder);
int OSSL_DECODER_CTX_add_extra(OSSL_DECODER_CTX *ctx,
    OSSL_LIB_CTX *libctx, const char *propq);
int OSSL_DECODER_CTX_get_num_decoders(OSSL_DECODER_CTX *ctx);

typedef struct ossl_decoder_instance_st OSSL_DECODER_INSTANCE;
OSSL_DECODER *
OSSL_DECODER_INSTANCE_get_decoder(OSSL_DECODER_INSTANCE *decoder_inst);
void *
OSSL_DECODER_INSTANCE_get_decoder_ctx(OSSL_DECODER_INSTANCE *decoder_inst);
const char *
OSSL_DECODER_INSTANCE_get_input_type(OSSL_DECODER_INSTANCE *decoder_inst);
const char *
OSSL_DECODER_INSTANCE_get_input_structure(OSSL_DECODER_INSTANCE *decoder_inst,
    int *was_set);

typedef int OSSL_DECODER_CONSTRUCT(OSSL_DECODER_INSTANCE *decoder_inst,
    const OSSL_PARAM *params,
    void *construct_data);
typedef void OSSL_DECODER_CLEANUP(void *construct_data);

int OSSL_DECODER_CTX_set_construct(OSSL_DECODER_CTX *ctx,
    OSSL_DECODER_CONSTRUCT *construct);
int OSSL_DECODER_CTX_set_construct_data(OSSL_DECODER_CTX *ctx,
    void *construct_data);
int OSSL_DECODER_CTX_set_cleanup(OSSL_DECODER_CTX *ctx,
    OSSL_DECODER_CLEANUP *cleanup);
OSSL_DECODER_CONSTRUCT *OSSL_DECODER_CTX_get_construct(OSSL_DECODER_CTX *ctx);
void *OSSL_DECODER_CTX_get_construct_data(OSSL_DECODER_CTX *ctx);
OSSL_DECODER_CLEANUP *OSSL_DECODER_CTX_get_cleanup(OSSL_DECODER_CTX *ctx);

int OSSL_DECODER_export(OSSL_DECODER_INSTANCE *decoder_inst,
    void *reference, size_t reference_sz,
    OSSL_CALLBACK *export_cb, void *export_cbarg);

int OSSL_DECODER_from_bio(OSSL_DECODER_CTX *ctx, BIO *in);
#ifndef OPENSSL_NO_STDIO
int OSSL_DECODER_from_fp(OSSL_DECODER_CTX *ctx, FILE *in);
#endif
int OSSL_DECODER_from_data(OSSL_DECODER_CTX *ctx, const unsigned char **pdata,
    size_t *pdata_len);

/*
 * Create the OSSL_DECODER_CTX with an associated type.  This will perform
 * an implicit OSSL_DECODER_fetch(), suitable for the object of that type.
 */
OSSL_DECODER_CTX *
OSSL_DECODER_CTX_new_for_pkey(EVP_PKEY **pkey,
    const char *input_type,
    const char *input_struct,
    const char *keytype, int selection,
    OSSL_LIB_CTX *libctx, const char *propquery);

#ifdef __cplusplus
}
#endif
#endif
