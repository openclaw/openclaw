/*
 * Copyright 1995-2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_STACK_H
#define OPENSSL_STACK_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_STACK_H
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct stack_st OPENSSL_STACK; /* Use STACK_OF(...) instead */

typedef int (*OPENSSL_sk_compfunc)(const void *, const void *);
typedef void (*OPENSSL_sk_freefunc)(void *);
typedef void (*OPENSSL_sk_freefunc_thunk)(OPENSSL_sk_freefunc, void *);
typedef void *(*OPENSSL_sk_copyfunc)(const void *);

int OPENSSL_sk_num(const OPENSSL_STACK *);
void *OPENSSL_sk_value(const OPENSSL_STACK *, int);

void *OPENSSL_sk_set(OPENSSL_STACK *st, int i, const void *data);

OPENSSL_STACK *OPENSSL_sk_new(OPENSSL_sk_compfunc cmp);
OPENSSL_STACK *OPENSSL_sk_new_null(void);
OPENSSL_STACK *OPENSSL_sk_new_reserve(OPENSSL_sk_compfunc c, int n);
OPENSSL_STACK *OPENSSL_sk_set_thunks(OPENSSL_STACK *st, OPENSSL_sk_freefunc_thunk f_thunk);
int OPENSSL_sk_reserve(OPENSSL_STACK *st, int n);
void OPENSSL_sk_free(OPENSSL_STACK *);
void OPENSSL_sk_pop_free(OPENSSL_STACK *st, OPENSSL_sk_freefunc func);
OPENSSL_STACK *OPENSSL_sk_deep_copy(const OPENSSL_STACK *,
    OPENSSL_sk_copyfunc c,
    OPENSSL_sk_freefunc f);
int OPENSSL_sk_insert(OPENSSL_STACK *sk, const void *data, int where);
void *OPENSSL_sk_delete(OPENSSL_STACK *st, int loc);
void *OPENSSL_sk_delete_ptr(OPENSSL_STACK *st, const void *p);
int OPENSSL_sk_find(OPENSSL_STACK *st, const void *data);
int OPENSSL_sk_find_ex(OPENSSL_STACK *st, const void *data);
int OPENSSL_sk_find_all(OPENSSL_STACK *st, const void *data, int *pnum);
int OPENSSL_sk_push(OPENSSL_STACK *st, const void *data);
int OPENSSL_sk_unshift(OPENSSL_STACK *st, const void *data);
void *OPENSSL_sk_shift(OPENSSL_STACK *st);
void *OPENSSL_sk_pop(OPENSSL_STACK *st);
void OPENSSL_sk_zero(OPENSSL_STACK *st);
OPENSSL_sk_compfunc OPENSSL_sk_set_cmp_func(OPENSSL_STACK *sk,
    OPENSSL_sk_compfunc cmp);
OPENSSL_STACK *OPENSSL_sk_dup(const OPENSSL_STACK *st);
void OPENSSL_sk_sort(OPENSSL_STACK *st);
int OPENSSL_sk_is_sorted(const OPENSSL_STACK *st);

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define _STACK OPENSSL_STACK
#define sk_num OPENSSL_sk_num
#define sk_value OPENSSL_sk_value
#define sk_set OPENSSL_sk_set
#define sk_new OPENSSL_sk_new
#define sk_new_null OPENSSL_sk_new_null
#define sk_free OPENSSL_sk_free
#define sk_pop_free OPENSSL_sk_pop_free
#define sk_deep_copy OPENSSL_sk_deep_copy
#define sk_insert OPENSSL_sk_insert
#define sk_delete OPENSSL_sk_delete
#define sk_delete_ptr OPENSSL_sk_delete_ptr
#define sk_find OPENSSL_sk_find
#define sk_find_ex OPENSSL_sk_find_ex
#define sk_push OPENSSL_sk_push
#define sk_unshift OPENSSL_sk_unshift
#define sk_shift OPENSSL_sk_shift
#define sk_pop OPENSSL_sk_pop
#define sk_zero OPENSSL_sk_zero
#define sk_set_cmp_func OPENSSL_sk_set_cmp_func
#define sk_dup OPENSSL_sk_dup
#define sk_sort OPENSSL_sk_sort
#define sk_is_sorted OPENSSL_sk_is_sorted
#endif

#ifdef __cplusplus
}
#endif

#endif
