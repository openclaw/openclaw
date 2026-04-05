/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/delta.h
 * \brief       Delta filter
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/**
 * \brief       Filter ID
 *
 * Filter ID of the Delta filter. This is used as lzma_filter.id.
 */
#define LZMA_FILTER_DELTA       LZMA_VLI_C(0x03)


/**
 * \brief       Type of the delta calculation
 *
 * Currently only byte-wise delta is supported. Other possible types could
 * be, for example, delta of 16/32/64-bit little/big endian integers, but
 * these are not currently planned since byte-wise delta is almost as good.
 */
typedef enum {
	LZMA_DELTA_TYPE_BYTE
} lzma_delta_type;


/**
 * \brief       Options for the Delta filter
 *
 * These options are needed by both encoder and decoder.
 */
typedef struct {
	/** For now, this must always be LZMA_DELTA_TYPE_BYTE. */
	lzma_delta_type type;

	/**
	 * \brief       Delta distance
	 *
	 * With the only currently supported type, LZMA_DELTA_TYPE_BYTE,
	 * the distance is as bytes.
	 *
	 * Examples:
	 *  - 16-bit stereo audio: distance = 4 bytes
	 *  - 24-bit RGB image data: distance = 3 bytes
	 */
	uint32_t dist;

	/**
	 * \brief       Minimum value for lzma_options_delta.dist.
	 */
#	define LZMA_DELTA_DIST_MIN 1

	/**
	 * \brief       Maximum value for lzma_options_delta.dist.
	 */
#	define LZMA_DELTA_DIST_MAX 256

	/*
	 * Reserved space to allow possible future extensions without
	 * breaking the ABI. You should not touch these, because the names
	 * of these variables may change. These are and will never be used
	 * when type is LZMA_DELTA_TYPE_BYTE, so it is safe to leave these
	 * uninitialized.
	 */

	/** \private     Reserved member. */
	uint32_t reserved_int1;

	/** \private     Reserved member. */
	uint32_t reserved_int2;

	/** \private     Reserved member. */
	uint32_t reserved_int3;

	/** \private     Reserved member. */
	uint32_t reserved_int4;

	/** \private     Reserved member. */
	void *reserved_ptr1;

	/** \private     Reserved member. */
	void *reserved_ptr2;

} lzma_options_delta;
