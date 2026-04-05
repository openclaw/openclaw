/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/vli.h
 * \brief       Variable-length integer handling
 * \note        Never include this file directly. Use <lzma.h> instead.
 *
 * In the .xz format, most integers are encoded in a variable-length
 * representation, which is sometimes called little endian base-128 encoding.
 * This saves space when smaller values are more likely than bigger values.
 *
 * The encoding scheme encodes seven bits to every byte, using minimum
 * number of bytes required to represent the given value. Encodings that use
 * non-minimum number of bytes are invalid, thus every integer has exactly
 * one encoded representation. The maximum number of bits in a VLI is 63,
 * thus the vli argument must be less than or equal to UINT64_MAX / 2. You
 * should use LZMA_VLI_MAX for clarity.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/**
 * \brief       Maximum supported value of a variable-length integer
 */
#define LZMA_VLI_MAX (UINT64_MAX / 2)

/**
 * \brief       VLI value to denote that the value is unknown
 */
#define LZMA_VLI_UNKNOWN UINT64_MAX

/**
 * \brief       Maximum supported encoded length of variable length integers
 */
#define LZMA_VLI_BYTES_MAX 9

/**
 * \brief       VLI constant suffix
 */
#define LZMA_VLI_C(n) UINT64_C(n)


/**
 * \brief       Variable-length integer type
 *
 * Valid VLI values are in the range [0, LZMA_VLI_MAX]. Unknown value is
 * indicated with LZMA_VLI_UNKNOWN, which is the maximum value of the
 * underlying integer type.
 *
 * lzma_vli will be uint64_t for the foreseeable future. If a bigger size
 * is needed in the future, it is guaranteed that 2 * LZMA_VLI_MAX will
 * not overflow lzma_vli. This simplifies integer overflow detection.
 */
typedef uint64_t lzma_vli;


/**
 * \brief       Validate a variable-length integer
 *
 * This is useful to test that application has given acceptable values
 * for example in the uncompressed_size and compressed_size variables.
 *
 * \return      True if the integer is representable as a VLI or if it
 *              indicates an unknown value. False otherwise.
 */
#define lzma_vli_is_valid(vli) \
	((vli) <= LZMA_VLI_MAX || (vli) == LZMA_VLI_UNKNOWN)


/**
 * \brief       Encode a variable-length integer
 *
 * This function has two modes: single-call and multi-call. Single-call mode
 * encodes the whole integer at once; it is an error if the output buffer is
 * too small. Multi-call mode saves the position in *vli_pos, and thus it is
 * possible to continue encoding if the buffer becomes full before the whole
 * integer has been encoded.
 *
 * \param       vli       Integer to be encoded
 * \param[out]  vli_pos   How many VLI-encoded bytes have already been written
 *                        out. When starting to encode a new integer in
 *                        multi-call mode, *vli_pos must be set to zero.
 *                        To use single-call encoding, set vli_pos to NULL.
 * \param[out]  out       Beginning of the output buffer
 * \param[out]  out_pos   The next byte will be written to out[*out_pos].
 * \param       out_size  Size of the out buffer; the first byte into
 *                        which no data is written to is out[out_size].
 *
 * \return      Slightly different return values are used in multi-call and
 *              single-call modes.
 *
 *              Single-call (vli_pos == NULL):
 *              - LZMA_OK: Integer successfully encoded.
 *              - LZMA_PROG_ERROR: Arguments are not sane. This can be due
 *                to too little output space; single-call mode doesn't use
 *                LZMA_BUF_ERROR, since the application should have checked
 *                the encoded size with lzma_vli_size().
 *
 *              Multi-call (vli_pos != NULL):
 *              - LZMA_OK: So far all OK, but the integer is not
 *                completely written out yet.
 *              - LZMA_STREAM_END: Integer successfully encoded.
 *              - LZMA_BUF_ERROR: No output space was provided.
 *              - LZMA_PROG_ERROR: Arguments are not sane.
 */
extern LZMA_API(lzma_ret) lzma_vli_encode(lzma_vli vli, size_t *vli_pos,
		uint8_t *out, size_t *out_pos, size_t out_size) lzma_nothrow;


/**
 * \brief       Decode a variable-length integer
 *
 * Like lzma_vli_encode(), this function has single-call and multi-call modes.
 *
 * \param[out]  vli       Pointer to decoded integer. The decoder will
 *                        initialize it to zero when *vli_pos == 0, so
 *                        application isn't required to initialize *vli.
 * \param[out]  vli_pos   How many bytes have already been decoded. When
 *                        starting to decode a new integer in multi-call
 *                        mode, *vli_pos must be initialized to zero. To
 *                        use single-call decoding, set vli_pos to NULL.
 * \param       in        Beginning of the input buffer
 * \param[out]  in_pos    The next byte will be read from in[*in_pos].
 * \param       in_size   Size of the input buffer; the first byte that
 *                        won't be read is in[in_size].
 *
 * \return      Slightly different return values are used in multi-call and
 *              single-call modes.
 *
 *              Single-call (vli_pos == NULL):
 *              - LZMA_OK: Integer successfully decoded.
 *              - LZMA_DATA_ERROR: Integer is corrupt. This includes hitting
 *                the end of the input buffer before the whole integer was
 *                decoded; providing no input at all will use LZMA_DATA_ERROR.
 *              - LZMA_PROG_ERROR: Arguments are not sane.
 *
 *              Multi-call (vli_pos != NULL):
 *              - LZMA_OK: So far all OK, but the integer is not
 *                completely decoded yet.
 *              - LZMA_STREAM_END: Integer successfully decoded.
 *              - LZMA_DATA_ERROR: Integer is corrupt.
 *              - LZMA_BUF_ERROR: No input was provided.
 *              - LZMA_PROG_ERROR: Arguments are not sane.
 */
extern LZMA_API(lzma_ret) lzma_vli_decode(lzma_vli *vli, size_t *vli_pos,
		const uint8_t *in, size_t *in_pos, size_t in_size)
		lzma_nothrow;


/**
 * \brief       Get the number of bytes required to encode a VLI
 *
 * \param       vli       Integer whose encoded size is to be determined
 *
 * \return      Number of bytes on success (1-9). If vli isn't valid,
 *              zero is returned.
 */
extern LZMA_API(uint32_t) lzma_vli_size(lzma_vli vli)
		lzma_nothrow lzma_attr_pure;
