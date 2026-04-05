/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/lzma12.h
 * \brief       LZMA1 and LZMA2 filters
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/**
 * \brief       LZMA1 Filter ID (for raw encoder/decoder only, not in .xz)
 *
 * LZMA1 is the very same thing as what was called just LZMA in LZMA Utils,
 * 7-Zip, and LZMA SDK. It's called LZMA1 here to prevent developers from
 * accidentally using LZMA when they actually want LZMA2.
 */
#define LZMA_FILTER_LZMA1       LZMA_VLI_C(0x4000000000000001)

/**
 * \brief       LZMA1 Filter ID with extended options (for raw encoder/decoder)
 *
 * This is like LZMA_FILTER_LZMA1 but with this ID a few extra options
 * are supported in the lzma_options_lzma structure:
 *
 *   - A flag to tell the encoder if the end of payload marker (EOPM) alias
 *     end of stream (EOS) marker must be written at the end of the stream.
 *     In contrast, LZMA_FILTER_LZMA1 always writes the end marker.
 *
 *   - Decoder needs to be told the uncompressed size of the stream
 *     or that it is unknown (using the special value UINT64_MAX).
 *     If the size is known, a flag can be set to allow the presence of
 *     the end marker anyway. In contrast, LZMA_FILTER_LZMA1 always
 *     behaves as if the uncompressed size was unknown.
 *
 * This allows handling file formats where LZMA1 streams are used but where
 * the end marker isn't allowed or where it might not (always) be present.
 * This extended LZMA1 functionality is provided as a Filter ID for raw
 * encoder and decoder instead of adding new encoder and decoder initialization
 * functions because this way it is possible to also use extra filters,
 * for example, LZMA_FILTER_X86 in a filter chain with LZMA_FILTER_LZMA1EXT,
 * which might be needed to handle some file formats.
 */
#define LZMA_FILTER_LZMA1EXT    LZMA_VLI_C(0x4000000000000002)

/**
 * \brief       LZMA2 Filter ID
 *
 * Usually you want this instead of LZMA1. Compared to LZMA1, LZMA2 adds
 * support for LZMA_SYNC_FLUSH, uncompressed chunks (smaller expansion
 * when trying to compress incompressible data), possibility to change
 * lc/lp/pb in the middle of encoding, and some other internal improvements.
 */
#define LZMA_FILTER_LZMA2       LZMA_VLI_C(0x21)


/**
 * \brief       Match finders
 *
 * Match finder has major effect on both speed and compression ratio.
 * Usually hash chains are faster than binary trees.
 *
 * If you will use LZMA_SYNC_FLUSH often, the hash chains may be a better
 * choice, because binary trees get much higher compression ratio penalty
 * with LZMA_SYNC_FLUSH.
 *
 * The memory usage formulas are only rough estimates, which are closest to
 * reality when dict_size is a power of two. The formulas are  more complex
 * in reality, and can also change a little between liblzma versions. Use
 * lzma_raw_encoder_memusage() to get more accurate estimate of memory usage.
 */
typedef enum {
	LZMA_MF_HC3     = 0x03,
		/**<
		 * \brief       Hash Chain with 2- and 3-byte hashing
		 *
		 * Minimum nice_len: 3
		 *
		 * Memory usage:
		 *  - dict_size <= 16 MiB: dict_size * 7.5
		 *  - dict_size > 16 MiB: dict_size * 5.5 + 64 MiB
		 */

	LZMA_MF_HC4     = 0x04,
		/**<
		 * \brief       Hash Chain with 2-, 3-, and 4-byte hashing
		 *
		 * Minimum nice_len: 4
		 *
		 * Memory usage:
		 *  - dict_size <= 32 MiB: dict_size * 7.5
		 *  - dict_size > 32 MiB: dict_size * 6.5
		 */

	LZMA_MF_BT2     = 0x12,
		/**<
		 * \brief       Binary Tree with 2-byte hashing
		 *
		 * Minimum nice_len: 2
		 *
		 * Memory usage: dict_size * 9.5
		 */

	LZMA_MF_BT3     = 0x13,
		/**<
		 * \brief       Binary Tree with 2- and 3-byte hashing
		 *
		 * Minimum nice_len: 3
		 *
		 * Memory usage:
		 *  - dict_size <= 16 MiB: dict_size * 11.5
		 *  - dict_size > 16 MiB: dict_size * 9.5 + 64 MiB
		 */

	LZMA_MF_BT4     = 0x14
		/**<
		 * \brief       Binary Tree with 2-, 3-, and 4-byte hashing
		 *
		 * Minimum nice_len: 4
		 *
		 * Memory usage:
		 *  - dict_size <= 32 MiB: dict_size * 11.5
		 *  - dict_size > 32 MiB: dict_size * 10.5
		 */
} lzma_match_finder;


/**
 * \brief       Test if given match finder is supported
 *
 * It is safe to call this with a value that isn't listed in
 * lzma_match_finder enumeration; the return value will be false.
 *
 * There is no way to list which match finders are available in this
 * particular liblzma version and build. It would be useless, because
 * a new match finder, which the application developer wasn't aware,
 * could require giving additional options to the encoder that the older
 * match finders don't need.
 *
 * \param       match_finder    Match finder ID
 *
 * \return      lzma_bool:
 *              - true if the match finder is supported by this liblzma build.
 *              - false otherwise.
 */
extern LZMA_API(lzma_bool) lzma_mf_is_supported(lzma_match_finder match_finder)
		lzma_nothrow lzma_attr_const;


/**
 * \brief       Compression modes
 *
 * This selects the function used to analyze the data produced by the match
 * finder.
 */
typedef enum {
	LZMA_MODE_FAST = 1,
		/**<
		 * \brief       Fast compression
		 *
		 * Fast mode is usually at its best when combined with
		 * a hash chain match finder.
		 */

	LZMA_MODE_NORMAL = 2
		/**<
		 * \brief       Normal compression
		 *
		 * This is usually notably slower than fast mode. Use this
		 * together with binary tree match finders to expose the
		 * full potential of the LZMA1 or LZMA2 encoder.
		 */
} lzma_mode;


/**
 * \brief       Test if given compression mode is supported
 *
 * It is safe to call this with a value that isn't listed in lzma_mode
 * enumeration; the return value will be false.
 *
 * There is no way to list which modes are available in this particular
 * liblzma version and build. It would be useless, because a new compression
 * mode, which the application developer wasn't aware, could require giving
 * additional options to the encoder that the older modes don't need.
 *
 * \param       mode    Mode ID.
 *
 * \return      lzma_bool:
 *              - true if the compression mode is supported by this liblzma
 *                build.
 *              - false otherwise.
 */
extern LZMA_API(lzma_bool) lzma_mode_is_supported(lzma_mode mode)
		lzma_nothrow lzma_attr_const;


/**
 * \brief       Options specific to the LZMA1 and LZMA2 filters
 *
 * Since LZMA1 and LZMA2 share most of the code, it's simplest to share
 * the options structure too. For encoding, all but the reserved variables
 * need to be initialized unless specifically mentioned otherwise.
 * lzma_lzma_preset() can be used to get a good starting point.
 *
 * For raw decoding, both LZMA1 and LZMA2 need dict_size, preset_dict, and
 * preset_dict_size (if preset_dict != NULL). LZMA1 needs also lc, lp, and pb.
 */
typedef struct {
	/**
	 * \brief       Dictionary size in bytes
	 *
	 * Dictionary size indicates how many bytes of the recently processed
	 * uncompressed data is kept in memory. One method to reduce size of
	 * the uncompressed data is to store distance-length pairs, which
	 * indicate what data to repeat from the dictionary buffer. Thus,
	 * the bigger the dictionary, the better the compression ratio
	 * usually is.
	 *
	 * Maximum size of the dictionary depends on multiple things:
	 *  - Memory usage limit
	 *  - Available address space (not a problem on 64-bit systems)
	 *  - Selected match finder (encoder only)
	 *
	 * Currently the maximum dictionary size for encoding is 1.5 GiB
	 * (i.e. (UINT32_C(1) << 30) + (UINT32_C(1) << 29)) even on 64-bit
	 * systems for certain match finder implementation reasons. In the
	 * future, there may be match finders that support bigger
	 * dictionaries.
	 *
	 * Decoder already supports dictionaries up to 4 GiB - 1 B (i.e.
	 * UINT32_MAX), so increasing the maximum dictionary size of the
	 * encoder won't cause problems for old decoders.
	 *
	 * Because extremely small dictionaries sizes would have unneeded
	 * overhead in the decoder, the minimum dictionary size is 4096 bytes.
	 *
	 * \note        When decoding, too big dictionary does no other harm
	 *              than wasting memory.
	 */
	uint32_t dict_size;
#	define LZMA_DICT_SIZE_MIN       UINT32_C(4096)
#	define LZMA_DICT_SIZE_DEFAULT   (UINT32_C(1) << 23)

	/**
	 * \brief       Pointer to an initial dictionary
	 *
	 * It is possible to initialize the LZ77 history window using
	 * a preset dictionary. It is useful when compressing many
	 * similar, relatively small chunks of data independently from
	 * each other. The preset dictionary should contain typical
	 * strings that occur in the files being compressed. The most
	 * probable strings should be near the end of the preset dictionary.
	 *
	 * This feature should be used only in special situations. For
	 * now, it works correctly only with raw encoding and decoding.
	 * Currently none of the container formats supported by
	 * liblzma allow preset dictionary when decoding, thus if
	 * you create a .xz or .lzma file with preset dictionary, it
	 * cannot be decoded with the regular decoder functions. In the
	 * future, the .xz format will likely get support for preset
	 * dictionary though.
	 */
	const uint8_t *preset_dict;

	/**
	 * \brief       Size of the preset dictionary
	 *
	 * Specifies the size of the preset dictionary. If the size is
	 * bigger than dict_size, only the last dict_size bytes are
	 * processed.
	 *
	 * This variable is read only when preset_dict is not NULL.
	 * If preset_dict is not NULL but preset_dict_size is zero,
	 * no preset dictionary is used (identical to only setting
	 * preset_dict to NULL).
	 */
	uint32_t preset_dict_size;

	/**
	 * \brief       Number of literal context bits
	 *
	 * How many of the highest bits of the previous uncompressed
	 * eight-bit byte (also known as 'literal') are taken into
	 * account when predicting the bits of the next literal.
	 *
	 * E.g. in typical English text, an upper-case letter is
	 * often followed by a lower-case letter, and a lower-case
	 * letter is usually followed by another lower-case letter.
	 * In the US-ASCII character set, the highest three bits are 010
	 * for upper-case letters and 011 for lower-case letters.
	 * When lc is at least 3, the literal coding can take advantage of
	 * this property in the uncompressed data.
	 *
	 * There is a limit that applies to literal context bits and literal
	 * position bits together: lc + lp <= 4. Without this limit the
	 * decoding could become very slow, which could have security related
	 * results in some cases like email servers doing virus scanning.
	 * This limit also simplifies the internal implementation in liblzma.
	 *
	 * There may be LZMA1 streams that have lc + lp > 4 (maximum possible
	 * lc would be 8). It is not possible to decode such streams with
	 * liblzma.
	 */
	uint32_t lc;
#	define LZMA_LCLP_MIN    0
#	define LZMA_LCLP_MAX    4
#	define LZMA_LC_DEFAULT  3

	/**
	 * \brief       Number of literal position bits
	 *
	 * lp affects what kind of alignment in the uncompressed data is
	 * assumed when encoding literals. A literal is a single 8-bit byte.
	 * See pb below for more information about alignment.
	 */
	uint32_t lp;
#	define LZMA_LP_DEFAULT  0

	/**
	 * \brief       Number of position bits
	 *
	 * pb affects what kind of alignment in the uncompressed data is
	 * assumed in general. The default means four-byte alignment
	 * (2^ pb =2^2=4), which is often a good choice when there's
	 * no better guess.
	 *
	 * When the alignment is known, setting pb accordingly may reduce
	 * the file size a little. E.g. with text files having one-byte
	 * alignment (US-ASCII, ISO-8859-*, UTF-8), setting pb=0 can
	 * improve compression slightly. For UTF-16 text, pb=1 is a good
	 * choice. If the alignment is an odd number like 3 bytes, pb=0
	 * might be the best choice.
	 *
	 * Even though the assumed alignment can be adjusted with pb and
	 * lp, LZMA1 and LZMA2 still slightly favor 16-byte alignment.
	 * It might be worth taking into account when designing file formats
	 * that are likely to be often compressed with LZMA1 or LZMA2.
	 */
	uint32_t pb;
#	define LZMA_PB_MIN      0
#	define LZMA_PB_MAX      4
#	define LZMA_PB_DEFAULT  2

	/** Compression mode */
	lzma_mode mode;

	/**
	 * \brief       Nice length of a match
	 *
	 * This determines how many bytes the encoder compares from the match
	 * candidates when looking for the best match. Once a match of at
	 * least nice_len bytes long is found, the encoder stops looking for
	 * better candidates and encodes the match. (Naturally, if the found
	 * match is actually longer than nice_len, the actual length is
	 * encoded; it's not truncated to nice_len.)
	 *
	 * Bigger values usually increase the compression ratio and
	 * compression time. For most files, 32 to 128 is a good value,
	 * which gives very good compression ratio at good speed.
	 *
	 * The exact minimum value depends on the match finder. The maximum
	 * is 273, which is the maximum length of a match that LZMA1 and
	 * LZMA2 can encode.
	 */
	uint32_t nice_len;

	/** Match finder ID */
	lzma_match_finder mf;

	/**
	 * \brief       Maximum search depth in the match finder
	 *
	 * For every input byte, match finder searches through the hash chain
	 * or binary tree in a loop, each iteration going one step deeper in
	 * the chain or tree. The searching stops if
	 *  - a match of at least nice_len bytes long is found;
	 *  - all match candidates from the hash chain or binary tree have
	 *    been checked; or
	 *  - maximum search depth is reached.
	 *
	 * Maximum search depth is needed to prevent the match finder from
	 * wasting too much time in case there are lots of short match
	 * candidates. On the other hand, stopping the search before all
	 * candidates have been checked can reduce compression ratio.
	 *
	 * Setting depth to zero tells liblzma to use an automatic default
	 * value, that depends on the selected match finder and nice_len.
	 * The default is in the range [4, 200] or so (it may vary between
	 * liblzma versions).
	 *
	 * Using a bigger depth value than the default can increase
	 * compression ratio in some cases. There is no strict maximum value,
	 * but high values (thousands or millions) should be used with care:
	 * the encoder could remain fast enough with typical input, but
	 * malicious input could cause the match finder to slow down
	 * dramatically, possibly creating a denial of service attack.
	 */
	uint32_t depth;

	/**
	 * \brief       For LZMA_FILTER_LZMA1EXT: Extended flags
	 *
	 * This is used only with LZMA_FILTER_LZMA1EXT.
	 *
	 * Currently only one flag is supported, LZMA_LZMA1EXT_ALLOW_EOPM:
	 *
	 *   - Encoder: If the flag is set, then end marker is written just
	 *     like it is with LZMA_FILTER_LZMA1. Without this flag the
	 *     end marker isn't written and the application has to store
	 *     the uncompressed size somewhere outside the compressed stream.
	 *     To decompress streams without the end marker, the application
	 *     has to set the correct uncompressed size in ext_size_low and
	 *     ext_size_high.
	 *
	 *   - Decoder: If the uncompressed size in ext_size_low and
	 *     ext_size_high is set to the special value UINT64_MAX
	 *     (indicating unknown uncompressed size) then this flag is
	 *     ignored and the end marker must always be present, that is,
	 *     the behavior is identical to LZMA_FILTER_LZMA1.
	 *
	 *     Otherwise, if this flag isn't set, then the input stream
	 *     must not have the end marker; if the end marker is detected
	 *     then it will result in LZMA_DATA_ERROR. This is useful when
	 *     it is known that the stream must not have the end marker and
	 *     strict validation is wanted.
	 *
	 *     If this flag is set, then it is autodetected if the end marker
	 *     is present after the specified number of uncompressed bytes
	 *     has been decompressed (ext_size_low and ext_size_high). The
	 *     end marker isn't allowed in any other position. This behavior
	 *     is useful when uncompressed size is known but the end marker
	 *     may or may not be present. This is the case, for example,
	 *     in .7z files (valid .7z files that have the end marker in
	 *     LZMA1 streams are rare but they do exist).
	 */
	uint32_t ext_flags;
#	define LZMA_LZMA1EXT_ALLOW_EOPM   UINT32_C(0x01)

	/**
	 * \brief       For LZMA_FILTER_LZMA1EXT: Uncompressed size (low bits)
	 *
	 * The 64-bit uncompressed size is needed for decompression with
	 * LZMA_FILTER_LZMA1EXT. The size is ignored by the encoder.
	 *
	 * The special value UINT64_MAX indicates that the uncompressed size
	 * is unknown and that the end of payload marker (also known as
	 * end of stream marker) must be present to indicate the end of
	 * the LZMA1 stream. Any other value indicates the expected
	 * uncompressed size of the LZMA1 stream. (If LZMA1 was used together
	 * with filters that change the size of the data then the uncompressed
	 * size of the LZMA1 stream could be different than the final
	 * uncompressed size of the filtered stream.)
	 *
	 * ext_size_low holds the least significant 32 bits of the
	 * uncompressed size. The most significant 32 bits must be set
	 * in ext_size_high. The macro lzma_set_ext_size(opt_lzma, u64size)
	 * can be used to set these members.
	 *
	 * The 64-bit uncompressed size is split into two uint32_t variables
	 * because there were no reserved uint64_t members and using the
	 * same options structure for LZMA_FILTER_LZMA1, LZMA_FILTER_LZMA1EXT,
	 * and LZMA_FILTER_LZMA2 was otherwise more convenient than having
	 * a new options structure for LZMA_FILTER_LZMA1EXT. (Replacing two
	 * uint32_t members with one uint64_t changes the ABI on some systems
	 * as the alignment of this struct can increase from 4 bytes to 8.)
	 */
	uint32_t ext_size_low;

	/**
	 * \brief       For LZMA_FILTER_LZMA1EXT: Uncompressed size (high bits)
	 *
	 * This holds the most significant 32 bits of the uncompressed size.
	 */
	uint32_t ext_size_high;

	/*
	 * Reserved space to allow possible future extensions without
	 * breaking the ABI. You should not touch these, because the names
	 * of these variables may change. These are and will never be used
	 * with the currently supported options, so it is safe to leave these
	 * uninitialized.
	 */

	/** \private     Reserved member. */
	uint32_t reserved_int4;

	/** \private     Reserved member. */
	uint32_t reserved_int5;

	/** \private     Reserved member. */
	uint32_t reserved_int6;

	/** \private     Reserved member. */
	uint32_t reserved_int7;

	/** \private     Reserved member. */
	uint32_t reserved_int8;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum1;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum2;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum3;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum4;

	/** \private     Reserved member. */
	void *reserved_ptr1;

	/** \private     Reserved member. */
	void *reserved_ptr2;

} lzma_options_lzma;


/**
 * \brief       Macro to set the 64-bit uncompressed size in ext_size_*
 *
 * This might be convenient when decoding using LZMA_FILTER_LZMA1EXT.
 * This isn't used with LZMA_FILTER_LZMA1 or LZMA_FILTER_LZMA2.
 */
#define lzma_set_ext_size(opt_lzma2, u64size) \
do { \
	(opt_lzma2).ext_size_low = (uint32_t)(u64size); \
	(opt_lzma2).ext_size_high = (uint32_t)((uint64_t)(u64size) >> 32); \
} while (0)


/**
 * \brief       Set a compression preset to lzma_options_lzma structure
 *
 * 0 is the fastest and 9 is the slowest. These match the switches -0 .. -9
 * of the xz command line tool. In addition, it is possible to bitwise-or
 * flags to the preset. Currently only LZMA_PRESET_EXTREME is supported.
 * The flags are defined in container.h, because the flags are used also
 * with lzma_easy_encoder().
 *
 * The preset levels are subject to changes between liblzma versions.
 *
 * This function is available only if LZMA1 or LZMA2 encoder has been enabled
 * when building liblzma.
 *
 * If features (like certain match finders) have been disabled at build time,
 * then the function may return success (false) even though the resulting
 * LZMA1/LZMA2 options may not be usable for encoder initialization
 * (LZMA_OPTIONS_ERROR).
 *
 * \param[out]  options Pointer to LZMA1 or LZMA2 options to be filled
 * \param       preset  Preset level bitwse-ORed with preset flags
 *
 * \return      lzma_bool:
 *              - true if the preset is not supported (failure).
 *              - false otherwise (success).
 */
extern LZMA_API(lzma_bool) lzma_lzma_preset(
		lzma_options_lzma *options, uint32_t preset) lzma_nothrow;
