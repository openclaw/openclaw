/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/stream_flags.h
 * \brief       .xz Stream Header and Stream Footer encoder and decoder
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/**
 * \brief       Size of Stream Header and Stream Footer
 *
 * Stream Header and Stream Footer have the same size and they are not
 * going to change even if a newer version of the .xz file format is
 * developed in future.
 */
#define LZMA_STREAM_HEADER_SIZE 12


/**
 * \brief       Options for encoding/decoding Stream Header and Stream Footer
 */
typedef struct {
	/**
	 * \brief       Stream Flags format version
	 *
	 * To prevent API and ABI breakages if new features are needed in
	 * Stream Header or Stream Footer, a version number is used to
	 * indicate which members in this structure are in use. For now,
	 * version must always be zero. With non-zero version, the
	 * lzma_stream_header_encode() and lzma_stream_footer_encode()
	 * will return LZMA_OPTIONS_ERROR.
	 *
	 * lzma_stream_header_decode() and lzma_stream_footer_decode()
	 * will always set this to the lowest value that supports all the
	 * features indicated by the Stream Flags field. The application
	 * must check that the version number set by the decoding functions
	 * is supported by the application. Otherwise it is possible that
	 * the application will decode the Stream incorrectly.
	 */
	uint32_t version;

	/**
	 * \brief       Backward Size
	 *
	 * Backward Size must be a multiple of four bytes. In this Stream
	 * format version, Backward Size is the size of the Index field.
	 *
	 * Backward Size isn't actually part of the Stream Flags field, but
	 * it is convenient to include in this structure anyway. Backward
	 * Size is present only in the Stream Footer. There is no need to
	 * initialize backward_size when encoding Stream Header.
	 *
	 * lzma_stream_header_decode() always sets backward_size to
	 * LZMA_VLI_UNKNOWN so that it is convenient to use
	 * lzma_stream_flags_compare() when both Stream Header and Stream
	 * Footer have been decoded.
	 */
	lzma_vli backward_size;

	/**
	 * \brief       Minimum value for lzma_stream_flags.backward_size
	 */
#	define LZMA_BACKWARD_SIZE_MIN 4

	/**
	 * \brief       Maximum value for lzma_stream_flags.backward_size
	 */
#	define LZMA_BACKWARD_SIZE_MAX (LZMA_VLI_C(1) << 34)

	/**
	 * \brief       Check ID
	 *
	 * This indicates the type of the integrity check calculated from
	 * uncompressed data.
	 */
	lzma_check check;

	/*
	 * Reserved space to allow possible future extensions without
	 * breaking the ABI. You should not touch these, because the
	 * names of these variables may change.
	 *
	 * (We will never be able to use all of these since Stream Flags
	 * is just two bytes plus Backward Size of four bytes. But it's
	 * nice to have the proper types when they are needed.)
	 */

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum1;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum2;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum3;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum4;

	/** \private     Reserved member. */
	lzma_bool reserved_bool1;

	/** \private     Reserved member. */
	lzma_bool reserved_bool2;

	/** \private     Reserved member. */
	lzma_bool reserved_bool3;

	/** \private     Reserved member. */
	lzma_bool reserved_bool4;

	/** \private     Reserved member. */
	lzma_bool reserved_bool5;

	/** \private     Reserved member. */
	lzma_bool reserved_bool6;

	/** \private     Reserved member. */
	lzma_bool reserved_bool7;

	/** \private     Reserved member. */
	lzma_bool reserved_bool8;

	/** \private     Reserved member. */
	uint32_t reserved_int1;

	/** \private     Reserved member. */
	uint32_t reserved_int2;

} lzma_stream_flags;


/**
 * \brief       Encode Stream Header
 *
 * \param       options     Stream Header options to be encoded.
 *                          options->backward_size is ignored and doesn't
 *                          need to be initialized.
 * \param[out]  out         Beginning of the output buffer of
 *                          LZMA_STREAM_HEADER_SIZE bytes.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Encoding was successful.
 *              - LZMA_OPTIONS_ERROR: options->version is not supported by
 *                this liblzma version.
 *              - LZMA_PROG_ERROR: Invalid options.
 */
extern LZMA_API(lzma_ret) lzma_stream_header_encode(
		const lzma_stream_flags *options, uint8_t *out)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Encode Stream Footer
 *
 * \param       options     Stream Footer options to be encoded.
 * \param[out]  out         Beginning of the output buffer of
 *                          LZMA_STREAM_HEADER_SIZE bytes.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Encoding was successful.
 *              - LZMA_OPTIONS_ERROR: options->version is not supported by
 *                this liblzma version.
 *              - LZMA_PROG_ERROR: Invalid options.
 */
extern LZMA_API(lzma_ret) lzma_stream_footer_encode(
		const lzma_stream_flags *options, uint8_t *out)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Decode Stream Header
 *
 * options->backward_size is always set to LZMA_VLI_UNKNOWN. This is to
 * help comparing Stream Flags from Stream Header and Stream Footer with
 * lzma_stream_flags_compare().
 *
 * \note        When decoding .xz files that contain multiple Streams, it may
 *              make sense to print "file format not recognized" only if
 *              decoding of the Stream Header of the \a first Stream gives
 *              LZMA_FORMAT_ERROR. If non-first Stream Header gives
 *              LZMA_FORMAT_ERROR, the message used for LZMA_DATA_ERROR is
 *              probably more appropriate.
 *              For example, the Stream decoder in liblzma uses
 *              LZMA_DATA_ERROR if LZMA_FORMAT_ERROR is returned by
 *              lzma_stream_header_decode() when decoding non-first Stream.
 *
 * \param[out]  options     Target for the decoded Stream Header options.
 * \param       in          Beginning of the input buffer of
 *                          LZMA_STREAM_HEADER_SIZE bytes.
 *
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Decoding was successful.
 *              - LZMA_FORMAT_ERROR: Magic bytes don't match, thus the given
 *                buffer cannot be Stream Header.
 *              - LZMA_DATA_ERROR: CRC32 doesn't match, thus the header
 *                is corrupt.
 *              - LZMA_OPTIONS_ERROR: Unsupported options are present
 *                in the header.
 */
extern LZMA_API(lzma_ret) lzma_stream_header_decode(
		lzma_stream_flags *options, const uint8_t *in)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Decode Stream Footer
 *
 * \note        If Stream Header was already decoded successfully, but
 *              decoding Stream Footer returns LZMA_FORMAT_ERROR, the
 *              application should probably report some other error message
 *              than "file format not recognized". The file likely
 *              is corrupt (possibly truncated). The Stream decoder in liblzma
 *              uses LZMA_DATA_ERROR in this situation.
 *
 * \param[out]  options     Target for the decoded Stream Footer options.
 * \param       in          Beginning of the input buffer of
 *                          LZMA_STREAM_HEADER_SIZE bytes.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Decoding was successful.
 *              - LZMA_FORMAT_ERROR: Magic bytes don't match, thus the given
 *                buffer cannot be Stream Footer.
 *              - LZMA_DATA_ERROR: CRC32 doesn't match, thus the Stream Footer
 *                is corrupt.
 *              - LZMA_OPTIONS_ERROR: Unsupported options are present
 *                in Stream Footer.
 */
extern LZMA_API(lzma_ret) lzma_stream_footer_decode(
		lzma_stream_flags *options, const uint8_t *in)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Compare two lzma_stream_flags structures
 *
 * backward_size values are compared only if both are not
 * LZMA_VLI_UNKNOWN.
 *
 * \param       a       Pointer to lzma_stream_flags structure
 * \param       b       Pointer to lzma_stream_flags structure
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Both are equal. If either had backward_size set
 *                to LZMA_VLI_UNKNOWN, backward_size values were not
 *                compared or validated.
 *              - LZMA_DATA_ERROR: The structures differ.
 *              - LZMA_OPTIONS_ERROR: version in either structure is greater
 *                than the maximum supported version (currently zero).
 *              - LZMA_PROG_ERROR: Invalid value, e.g. invalid check or
 *                backward_size.
 */
extern LZMA_API(lzma_ret) lzma_stream_flags_compare(
		const lzma_stream_flags *a, const lzma_stream_flags *b)
		lzma_nothrow lzma_attr_pure;
