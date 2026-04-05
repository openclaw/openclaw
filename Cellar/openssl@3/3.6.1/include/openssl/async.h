/*
 * Copyright 2015-2022 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#include <stdlib.h>

#ifndef OPENSSL_ASYNC_H
#define OPENSSL_ASYNC_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_ASYNC_H
#endif

#if defined(_WIN32)
#if defined(BASETYPES) || defined(_WINDEF_H)
/* application has to include <windows.h> to use this */
#define OSSL_ASYNC_FD HANDLE
#define OSSL_BAD_ASYNC_FD INVALID_HANDLE_VALUE
#endif
#else
#define OSSL_ASYNC_FD int
#define OSSL_BAD_ASYNC_FD -1
#endif
#include <openssl/asyncerr.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct async_job_st ASYNC_JOB;
typedef struct async_wait_ctx_st ASYNC_WAIT_CTX;
typedef int (*ASYNC_callback_fn)(void *arg);

#define ASYNC_ERR 0
#define ASYNC_NO_JOBS 1
#define ASYNC_PAUSE 2
#define ASYNC_FINISH 3

#define ASYNC_STATUS_UNSUPPORTED 0
#define ASYNC_STATUS_ERR 1
#define ASYNC_STATUS_OK 2
#define ASYNC_STATUS_EAGAIN 3

int ASYNC_init_thread(size_t max_size, size_t init_size);
void ASYNC_cleanup_thread(void);

#ifdef OSSL_ASYNC_FD
ASYNC_WAIT_CTX *ASYNC_WAIT_CTX_new(void);
void ASYNC_WAIT_CTX_free(ASYNC_WAIT_CTX *ctx);
int ASYNC_WAIT_CTX_set_wait_fd(ASYNC_WAIT_CTX *ctx, const void *key,
    OSSL_ASYNC_FD fd,
    void *custom_data,
    void (*cleanup)(ASYNC_WAIT_CTX *, const void *,
        OSSL_ASYNC_FD, void *));
int ASYNC_WAIT_CTX_get_fd(ASYNC_WAIT_CTX *ctx, const void *key,
    OSSL_ASYNC_FD *fd, void **custom_data);
int ASYNC_WAIT_CTX_get_all_fds(ASYNC_WAIT_CTX *ctx, OSSL_ASYNC_FD *fd,
    size_t *numfds);
int ASYNC_WAIT_CTX_get_callback(ASYNC_WAIT_CTX *ctx,
    ASYNC_callback_fn *callback,
    void **callback_arg);
int ASYNC_WAIT_CTX_set_callback(ASYNC_WAIT_CTX *ctx,
    ASYNC_callback_fn callback,
    void *callback_arg);
int ASYNC_WAIT_CTX_set_status(ASYNC_WAIT_CTX *ctx, int status);
int ASYNC_WAIT_CTX_get_status(ASYNC_WAIT_CTX *ctx);
int ASYNC_WAIT_CTX_get_changed_fds(ASYNC_WAIT_CTX *ctx, OSSL_ASYNC_FD *addfd,
    size_t *numaddfds, OSSL_ASYNC_FD *delfd,
    size_t *numdelfds);
int ASYNC_WAIT_CTX_clear_fd(ASYNC_WAIT_CTX *ctx, const void *key);
#endif

int ASYNC_is_capable(void);

typedef void *(*ASYNC_stack_alloc_fn)(size_t *num);
typedef void (*ASYNC_stack_free_fn)(void *addr);

int ASYNC_set_mem_functions(ASYNC_stack_alloc_fn alloc_fn,
    ASYNC_stack_free_fn free_fn);
void ASYNC_get_mem_functions(ASYNC_stack_alloc_fn *alloc_fn,
    ASYNC_stack_free_fn *free_fn);

int ASYNC_start_job(ASYNC_JOB **job, ASYNC_WAIT_CTX *ctx, int *ret,
    int (*func)(void *), void *args, size_t size);
int ASYNC_pause_job(void);

ASYNC_JOB *ASYNC_get_current_job(void);
ASYNC_WAIT_CTX *ASYNC_get_wait_ctx(ASYNC_JOB *job);
void ASYNC_block_pause(void);
void ASYNC_unblock_pause(void);

#ifdef __cplusplus
}
#endif
#endif
