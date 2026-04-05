/*
 * Copyright 1995-2017 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_TXT_DB_H
#define OPENSSL_TXT_DB_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_TXT_DB_H
#endif

#include <openssl/opensslconf.h>
#include <openssl/bio.h>
#include <openssl/safestack.h>
#include <openssl/lhash.h>

#define DB_ERROR_OK 0
#define DB_ERROR_MALLOC 1
#define DB_ERROR_INDEX_CLASH 2
#define DB_ERROR_INDEX_OUT_OF_RANGE 3
#define DB_ERROR_NO_INDEX 4
#define DB_ERROR_INSERT_INDEX_CLASH 5
#define DB_ERROR_WRONG_NUM_FIELDS 6

#ifdef __cplusplus
extern "C" {
#endif

typedef OPENSSL_STRING *OPENSSL_PSTRING;
DEFINE_SPECIAL_STACK_OF(OPENSSL_PSTRING, OPENSSL_STRING)

typedef struct txt_db_st {
    int num_fields;
    STACK_OF(OPENSSL_PSTRING) *data;
    LHASH_OF(OPENSSL_STRING) **index;
    int (**qual)(OPENSSL_STRING *);
    long error;
    long arg1;
    long arg2;
    OPENSSL_STRING *arg_row;
} TXT_DB;

TXT_DB *TXT_DB_read(BIO *in, int num);
long TXT_DB_write(BIO *out, TXT_DB *db);
int TXT_DB_create_index(TXT_DB *db, int field, int (*qual)(OPENSSL_STRING *),
    OPENSSL_LH_HASHFUNC hash, OPENSSL_LH_COMPFUNC cmp);
void TXT_DB_free(TXT_DB *db);
OPENSSL_STRING *TXT_DB_get_by_index(TXT_DB *db, int idx,
    OPENSSL_STRING *value);
int TXT_DB_insert(TXT_DB *db, OPENSSL_STRING *value);

#ifdef __cplusplus
}
#endif

#endif
