/*
 * AES-CTR cipher
 * Copyright (c) 2015 Eran Kornblau <erankor at gmail dot com>
 *
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

#ifndef AVUTIL_AES_CTR_H
#define AVUTIL_AES_CTR_H

/**
 * @defgroup lavu_aes_ctr AES-CTR
 * @ingroup lavu_crypto
 * @{
 */

#include <stdint.h>

#include "attributes.h"

#define AES_CTR_KEY_SIZE (16)
#define AES_CTR_IV_SIZE (8)

struct AVAESCTR;

/**
 * Allocate an AVAESCTR context.
 */
struct AVAESCTR *av_aes_ctr_alloc(void);

/**
 * Initialize an AVAESCTR context.
 *
 * @param a The AVAESCTR context to initialize
 * @param key encryption key, must have a length of AES_CTR_KEY_SIZE
 */
int av_aes_ctr_init(struct AVAESCTR *a, const uint8_t *key);

/**
 * Release an AVAESCTR context.
 *
 * @param a The AVAESCTR context
 */
void av_aes_ctr_free(struct AVAESCTR *a);

/**
 * Process a buffer using a previously initialized context.
 *
 * @param a The AVAESCTR context
 * @param dst destination array, can be equal to src
 * @param src source array, can be equal to dst
 * @param size the size of src and dst
 */
void av_aes_ctr_crypt(struct AVAESCTR *a, uint8_t *dst, const uint8_t *src, int size);

/**
 * Get the current iv
 */
const uint8_t* av_aes_ctr_get_iv(struct AVAESCTR *a);

/**
 * Generate a random iv
 */
void av_aes_ctr_set_random_iv(struct AVAESCTR *a);

/**
 * Forcefully change the 8-byte iv
 */
void av_aes_ctr_set_iv(struct AVAESCTR *a, const uint8_t* iv);

/**
 * Forcefully change the "full" 16-byte iv, including the counter
 */
void av_aes_ctr_set_full_iv(struct AVAESCTR *a, const uint8_t* iv);

/**
 * Increment the top 64 bit of the iv (performed after each frame)
 */
void av_aes_ctr_increment_iv(struct AVAESCTR *a);

/**
 * @}
 */

#endif /* AVUTIL_AES_CTR_H */
