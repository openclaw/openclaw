/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/container.h
 * \brief       File formats
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/************
 * Encoding *
 ************/

/**
 * \brief       Default compression preset
 *
 * It's not straightforward to recommend a default preset, because in some
 * cases keeping the resource usage relatively low is more important that
 * getting the maximum compression ratio.
 */
#define LZMA_PRESET_DEFAULT     UINT32_C(6)


/**
 * \brief       Mask for preset level
 *
 * This is useful only if you need to extract the level from the preset
 * variable. That should be rare.
 */
#define LZMA_PRESET_LEVEL_MASK  UINT32_C(0x1F)


/*
 * Preset flags
 *
 * Currently only one flag is defined.
 */

/**
 * \brief       Extreme compression preset
 *
 * This flag modifies the preset to make the encoding significantly slower
 * while improving the compression ratio only marginally. This is useful
 * when you don't mind spending time to get as small result as possible.
 *
 * This flag doesn't affect the memory usage requirements of the decoder (at
 * least not significantly). The memory usage of the encoder may be increased
 * a little but only at the lowest preset levels (0-3).
 */
#define LZMA_PRESET_EXTREME       (UINT32_C(1) << 31)


/**
 * \brief       Multithreading options
 */
typedef struct {
	/**
	 * \brief       Flags
	 *
	 * Set this to zero if no flags are wanted.
	 *
	 * Encoder: No flags are currently supported.
	 *
	 * Decoder: Bitwise-or of zero or more of the decoder flags:
	 * - LZMA_TELL_NO_CHECK
	 * - LZMA_TELL_UNSUPPORTED_CHECK
	 * - LZMA_TELL_ANY_CHECK
	 * - LZMA_IGNORE_CHECK
	 * - LZMA_CONCATENATED
	 * - LZMA_FAIL_FAST
	 */
	uint32_t flags;

	/**
	 * \brief       Number of worker threads to use
	 */
	uint32_t threads;

	/**
	 * \brief       Encoder only: Maximum uncompressed size of a Block
	 *
	 * The encoder will start a new .xz Block every block_size bytes.
	 * Using LZMA_FULL_FLUSH or LZMA_FULL_BARRIER with lzma_code()
	 * the caller may tell liblzma to start a new Block earlier.
	 *
	 * With LZMA2, a recommended block size is 2-4 times the LZMA2
	 * dictionary size. With very small dictionaries, it is recommended
	 * to use at least 1 MiB block size for good compression ratio, even
	 * if this is more than four times the dictionary size. Note that
	 * these are only recommendations for typical use cases; feel free
	 * to use other values. Just keep in mind that using a block size
	 * less than the LZMA2 dictionary size is waste of RAM.
	 *
	 * Set this to 0 to let liblzma choose the block size depending
	 * on the compression options. For LZMA2 it will be 3*dict_size
	 * or 1 MiB, whichever is more.
	 *
	 * For each thread, about 3 * block_size bytes of memory will be
	 * allocated. This may change in later liblzma versions. If so,
	 * the memory usage will probably be reduced, not increased.
	 */
	uint64_t block_size;

	/**
	 * \brief       Timeout to allow lzma_code() to return early
	 *
	 * Multithreading can make liblzma consume input and produce
	 * output in a very bursty way: it may first read a lot of input
	 * to fill internal buffers, then no input or output occurs for
	 * a while.
	 *
	 * In single-threaded mode, lzma_code() won't return until it has
	 * either consumed all the input or filled the output buffer. If
	 * this is done in multithreaded mode, it may cause a call
	 * lzma_code() to take even tens of seconds, which isn't acceptable
	 * in all applications.
	 *
	 * To avoid very long blocking times in lzma_code(), a timeout
	 * (in milliseconds) may be set here. If lzma_code() would block
	 * longer than this number of milliseconds, it will return with
	 * LZMA_OK. Reasonable values are 100 ms or more. The xz command
	 * line tool uses 300 ms.
	 *
	 * If long blocking times are acceptable, set timeout to a special
	 * value of 0. This will disable the timeout mechanism and will make
	 * lzma_code() block until all the input is consumed or the output
	 * buffer has been filled.
	 *
	 * \note        Even with a timeout, lzma_code() might sometimes take
	 *              a long time to return. No timing guarantees are made.
	 */
	uint32_t timeout;

	/**
	 * \brief       Encoder only: Compression preset
	 *
	 * The preset is set just like with lzma_easy_encoder().
	 * The preset is ignored if filters below is non-NULL.
	 */
	uint32_t preset;

	/**
	 * \brief       Encoder only: Filter chain (alternative to a preset)
	 *
	 * If this is NULL, the preset above is used. Otherwise the preset
	 * is ignored and the filter chain specified here is used.
	 */
	const lzma_filter *filters;

	/**
	 * \brief       Encoder only: Integrity check type
	 *
	 * See check.h for available checks. The xz command line tool
	 * defaults to LZMA_CHECK_CRC64, which is a good choice if you
	 * are unsure.
	 */
	lzma_check check;

	/*
	 * Reserved space to allow possible future extensions without
	 * breaking the ABI. You should not touch these, because the names
	 * of these variables may change. These are and will never be used
	 * with the currently supported options, so it is safe to leave these
	 * uninitialized.
	 */
	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum1;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum2;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum3;

	/** \private     Reserved member. */
	uint32_t reserved_int1;

	/** \private     Reserved member. */
	uint32_t reserved_int2;

	/** \private     Reserved member. */
	uint32_t reserved_int3;

	/** \private     Reserved member. */
	uint32_t reserved_int4;

	/**
	 * \brief       Memory usage limit to reduce the number of threads
	 *
	 * Encoder: Ignored.
	 *
	 * Decoder:
	 *
	 * If the number of threads has been set so high that more than
	 * memlimit_threading bytes of memory would be needed, the number
	 * of threads will be reduced so that the memory usage will not exceed
	 * memlimit_threading bytes. However, if memlimit_threading cannot
	 * be met even in single-threaded mode, then decoding will continue
	 * in single-threaded mode and memlimit_threading may be exceeded
	 * even by a large amount. That is, memlimit_threading will never make
	 * lzma_code() return LZMA_MEMLIMIT_ERROR. To truly cap the memory
	 * usage, see memlimit_stop below.
	 *
	 * Setting memlimit_threading to UINT64_MAX or a similar huge value
	 * means that liblzma is allowed to keep the whole compressed file
	 * and the whole uncompressed file in memory in addition to the memory
	 * needed by the decompressor data structures used by each thread!
	 * In other words, a reasonable value limit must be set here or it
	 * will cause problems sooner or later. If you have no idea what
	 * a reasonable value could be, try lzma_physmem() / 4 as a starting
	 * point. Setting this limit will never prevent decompression of
	 * a file; this will only reduce the number of threads.
	 *
	 * If memlimit_threading is greater than memlimit_stop, then the value
	 * of memlimit_stop will be used for both.
	 */
	uint64_t memlimit_threading;

	/**
	 * \brief       Memory usage limit that should never be exceeded
	 *
	 * Encoder: Ignored.
	 *
	 * Decoder: If decompressing will need more than this amount of
	 * memory even in the single-threaded mode, then lzma_code() will
	 * return LZMA_MEMLIMIT_ERROR.
	 */
	uint64_t memlimit_stop;

	/** \private     Reserved member. */
	uint64_t reserved_int7;

	/** \private     Reserved member. */
	uint64_t reserved_int8;

	/** \private     Reserved member. */
	void *reserved_ptr1;

	/** \private     Reserved member. */
	void *reserved_ptr2;

	/** \private     Reserved member. */
	void *reserved_ptr3;

	/** \private     Reserved member. */
	void *reserved_ptr4;

} lzma_mt;


/**
 * \brief       Calculate approximate memory usage of easy encoder
 *
 * This function is a wrapper for lzma_raw_encoder_memusage().
 *
 * \param       preset  Compression preset (level and possible flags)
 *
 * \return      Number of bytes of memory required for the given
 *              preset when encoding or UINT64_MAX on error.
 */
extern LZMA_API(uint64_t) lzma_easy_encoder_memusage(uint32_t preset)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Calculate approximate decoder memory usage of a preset
 *
 * This function is a wrapper for lzma_raw_decoder_memusage().
 *
 * \param       preset  Compression preset (level and possible flags)
 *
 * \return      Number of bytes of memory required to decompress a file
 *              that was compressed using the given preset or UINT64_MAX
 *              on error.
 */
extern LZMA_API(uint64_t) lzma_easy_decoder_memusage(uint32_t preset)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Initialize .xz Stream encoder using a preset number
 *
 * This function is intended for those who just want to use the basic features
 * of liblzma (that is, most developers out there).
 *
 * If initialization fails (return value is not LZMA_OK), all the memory
 * allocated for *strm by liblzma is always freed. Thus, there is no need
 * to call lzma_end() after failed initialization.
 *
 * If initialization succeeds, use lzma_code() to do the actual encoding.
 * Valid values for 'action' (the second argument of lzma_code()) are
 * LZMA_RUN, LZMA_SYNC_FLUSH, LZMA_FULL_FLUSH, and LZMA_FINISH. In future,
 * there may be compression levels or flags that don't support LZMA_SYNC_FLUSH.
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 * \param       preset  Compression preset to use. A preset consist of level
 *                      number and zero or more flags. Usually flags aren't
 *                      used, so preset is simply a number [0, 9] which match
 *                      the options -0 ... -9 of the xz command line tool.
 *                      Additional flags can be set using bitwise-or with
 *                      the preset level number, e.g. 6 | LZMA_PRESET_EXTREME.
 * \param       check   Integrity check type to use. See check.h for available
 *                      checks. The xz command line tool defaults to
 *                      LZMA_CHECK_CRC64, which is a good choice if you are
 *                      unsure. LZMA_CHECK_CRC32 is good too as long as the
 *                      uncompressed file is not many gigabytes.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Initialization succeeded. Use lzma_code() to
 *                encode your data.
 *              - LZMA_MEM_ERROR: Memory allocation failed.
 *              - LZMA_OPTIONS_ERROR: The given compression preset is not
 *                supported by this build of liblzma.
 *              - LZMA_UNSUPPORTED_CHECK: The given check type is not
 *                supported by this liblzma build.
 *              - LZMA_PROG_ERROR: One or more of the parameters have values
 *                that will never be valid. For example, strm == NULL.
 */
extern LZMA_API(lzma_ret) lzma_easy_encoder(
		lzma_stream *strm, uint32_t preset, lzma_check check)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Single-call .xz Stream encoding using a preset number
 *
 * The maximum required output buffer size can be calculated with
 * lzma_stream_buffer_bound().
 *
 * \param       preset      Compression preset to use. See the description
 *                          in lzma_easy_encoder().
 * \param       check       Type of the integrity check to calculate from
 *                          uncompressed data.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 * \param       in          Beginning of the input buffer
 * \param       in_size     Size of the input buffer
 * \param[out]  out         Beginning of the output buffer
 * \param[out]  out_pos     The next byte will be written to out[*out_pos].
 *                          *out_pos is updated only if encoding succeeds.
 * \param       out_size    Size of the out buffer; the first byte into
 *                          which no data is written to is out[out_size].
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Encoding was successful.
 *              - LZMA_BUF_ERROR: Not enough output buffer space.
 *              - LZMA_UNSUPPORTED_CHECK
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_MEM_ERROR
 *              - LZMA_DATA_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_easy_buffer_encode(
		uint32_t preset, lzma_check check,
		const lzma_allocator *allocator,
		const uint8_t *in, size_t in_size,
		uint8_t *out, size_t *out_pos, size_t out_size) lzma_nothrow;


/**
 * \brief       Initialize .xz Stream encoder using a custom filter chain
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 * \param       filters Array of filters terminated with
 *                      .id == LZMA_VLI_UNKNOWN. See filters.h for more
 *                      information.
 * \param       check   Type of the integrity check to calculate from
 *                      uncompressed data.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Initialization was successful.
 *              - LZMA_MEM_ERROR
 *              - LZMA_UNSUPPORTED_CHECK
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_stream_encoder(lzma_stream *strm,
		const lzma_filter *filters, lzma_check check)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Calculate approximate memory usage of multithreaded .xz encoder
 *
 * Since doing the encoding in threaded mode doesn't affect the memory
 * requirements of single-threaded decompressor, you can use
 * lzma_easy_decoder_memusage(options->preset) or
 * lzma_raw_decoder_memusage(options->filters) to calculate
 * the decompressor memory requirements.
 *
 * \param       options Compression options
 *
 * \return      Number of bytes of memory required for encoding with the
 *              given options. If an error occurs, for example due to
 *              unsupported preset or filter chain, UINT64_MAX is returned.
 */
extern LZMA_API(uint64_t) lzma_stream_encoder_mt_memusage(
		const lzma_mt *options) lzma_nothrow lzma_attr_pure;


/**
 * \brief       Initialize multithreaded .xz Stream encoder
 *
 * This provides the functionality of lzma_easy_encoder() and
 * lzma_stream_encoder() as a single function for multithreaded use.
 *
 * The supported actions for lzma_code() are LZMA_RUN, LZMA_FULL_FLUSH,
 * LZMA_FULL_BARRIER, and LZMA_FINISH. Support for LZMA_SYNC_FLUSH might be
 * added in the future.
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 * \param       options Pointer to multithreaded compression options
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_UNSUPPORTED_CHECK
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_stream_encoder_mt(
		lzma_stream *strm, const lzma_mt *options)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Calculate recommended Block size for multithreaded .xz encoder
 *
 * This calculates a recommended Block size for multithreaded encoding given
 * a filter chain. This is used internally by lzma_stream_encoder_mt() to
 * determine the Block size if the block_size member is not set to the
 * special value of 0 in the lzma_mt options struct.
 *
 * If one wishes to change the filters between Blocks, this function is
 * helpful to set the block_size member of the lzma_mt struct before calling
 * lzma_stream_encoder_mt(). Since the block_size member represents the
 * maximum possible Block size for the multithreaded .xz encoder, one can
 * use this function to find the maximum recommended Block size based on
 * all planned filter chains. Otherwise, the multithreaded encoder will
 * base its maximum Block size on the first filter chain used (if the
 * block_size member is not set), which may unnecessarily limit the Block
 * size for a later filter chain.
 *
 * \param       filters   Array of filters terminated with
 *                        .id == LZMA_VLI_UNKNOWN.
 *
 * \return      Recommended Block size in bytes, or UINT64_MAX if
 *              an error occurred.
 */
extern LZMA_API(uint64_t) lzma_mt_block_size(const lzma_filter *filters)
		lzma_nothrow;


/**
 * \brief       Initialize .lzma encoder (legacy file format)
 *
 * The .lzma format is sometimes called the LZMA_Alone format, which is the
 * reason for the name of this function. The .lzma format supports only the
 * LZMA1 filter. There is no support for integrity checks like CRC32.
 *
 * Use this function if and only if you need to create files readable by
 * legacy LZMA tools such as LZMA Utils 4.32.x. Moving to the .xz format
 * is strongly recommended.
 *
 * The valid action values for lzma_code() are LZMA_RUN and LZMA_FINISH.
 * No kind of flushing is supported, because the file format doesn't make
 * it possible.
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 * \param       options Pointer to encoder options
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_alone_encoder(
		lzma_stream *strm, const lzma_options_lzma *options)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Calculate output buffer size for single-call Stream encoder
 *
 * When trying to compress incompressible data, the encoded size will be
 * slightly bigger than the input data. This function calculates how much
 * output buffer space is required to be sure that lzma_stream_buffer_encode()
 * doesn't return LZMA_BUF_ERROR.
 *
 * The calculated value is not exact, but it is guaranteed to be big enough.
 * The actual maximum output space required may be slightly smaller (up to
 * about 100 bytes). This should not be a problem in practice.
 *
 * If the calculated maximum size doesn't fit into size_t or would make the
 * Stream grow past LZMA_VLI_MAX (which should never happen in practice),
 * zero is returned to indicate the error.
 *
 * \note        The limit calculated by this function applies only to
 *              single-call encoding. Multi-call encoding may (and probably
 *              will) have larger maximum expansion when encoding
 *              incompressible data. Currently there is no function to
 *              calculate the maximum expansion of multi-call encoding.
 *
 * \param       uncompressed_size   Size in bytes of the uncompressed
 *                                  input data
 *
 * \return      Maximum number of bytes needed to store the compressed data.
 */
extern LZMA_API(size_t) lzma_stream_buffer_bound(size_t uncompressed_size)
		lzma_nothrow;


/**
 * \brief       Single-call .xz Stream encoder
 *
 * \param       filters     Array of filters terminated with
 *                          .id == LZMA_VLI_UNKNOWN. See filters.h for more
 *                          information.
 * \param       check       Type of the integrity check to calculate from
 *                          uncompressed data.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 * \param       in          Beginning of the input buffer
 * \param       in_size     Size of the input buffer
 * \param[out]  out         Beginning of the output buffer
 * \param[out]  out_pos     The next byte will be written to out[*out_pos].
 *                          *out_pos is updated only if encoding succeeds.
 * \param       out_size    Size of the out buffer; the first byte into
 *                          which no data is written to is out[out_size].
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Encoding was successful.
 *              - LZMA_BUF_ERROR: Not enough output buffer space.
 *              - LZMA_UNSUPPORTED_CHECK
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_MEM_ERROR
 *              - LZMA_DATA_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_stream_buffer_encode(
		lzma_filter *filters, lzma_check check,
		const lzma_allocator *allocator,
		const uint8_t *in, size_t in_size,
		uint8_t *out, size_t *out_pos, size_t out_size)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       MicroLZMA encoder
 *
 * The MicroLZMA format is a raw LZMA stream whose first byte (always 0x00)
 * has been replaced with bitwise-negation of the LZMA properties (lc/lp/pb).
 * This encoding ensures that the first byte of MicroLZMA stream is never
 * 0x00. There is no end of payload marker and thus the uncompressed size
 * must be stored separately. For the best error detection the dictionary
 * size should be stored separately as well but alternatively one may use
 * the uncompressed size as the dictionary size when decoding.
 *
 * With the MicroLZMA encoder, lzma_code() behaves slightly unusually.
 * The action argument must be LZMA_FINISH and the return value will never be
 * LZMA_OK. Thus the encoding is always done with a single lzma_code() after
 * the initialization. The benefit of the combination of initialization
 * function and lzma_code() is that memory allocations can be reused for
 * better performance.
 *
 * lzma_code() will try to encode as much input as is possible to fit into
 * the given output buffer. If not all input can be encoded, the stream will
 * be finished without encoding all the input. The caller must check both
 * input and output buffer usage after lzma_code() (total_in and total_out
 * in lzma_stream can be convenient). Often lzma_code() can fill the output
 * buffer completely if there is a lot of input, but sometimes a few bytes
 * may remain unused because the next LZMA symbol would require more space.
 *
 * lzma_stream.avail_out must be at least 6. Otherwise LZMA_PROG_ERROR
 * will be returned.
 *
 * The LZMA dictionary should be reasonably low to speed up the encoder
 * re-initialization. A good value is bigger than the resulting
 * uncompressed size of most of the output chunks. For example, if output
 * size is 4 KiB, dictionary size of 32 KiB or 64 KiB is good. If the
 * data compresses extremely well, even 128 KiB may be useful.
 *
 * The MicroLZMA format and this encoder variant were made with the EROFS
 * file system in mind. This format may be convenient in other embedded
 * uses too where many small streams are needed. XZ Embedded includes a
 * decoder for this format.
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 * \param       options Pointer to encoder options
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_STREAM_END: All good. Check the amounts of input used
 *                and output produced. Store the amount of input used
 *                (uncompressed size) as it needs to be known to decompress
 *                the data.
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_MEM_ERROR
 *              - LZMA_PROG_ERROR: In addition to the generic reasons for this
 *                error code, this may also be returned if there isn't enough
 *                output space (6 bytes) to create a valid MicroLZMA stream.
 */
extern LZMA_API(lzma_ret) lzma_microlzma_encoder(
		lzma_stream *strm, const lzma_options_lzma *options)
		lzma_nothrow;


/************
 * Decoding *
 ************/

/**
 * This flag makes lzma_code() return LZMA_NO_CHECK if the input stream
 * being decoded has no integrity check. Note that when used with
 * lzma_auto_decoder(), all .lzma files will trigger LZMA_NO_CHECK
 * if LZMA_TELL_NO_CHECK is used.
 */
#define LZMA_TELL_NO_CHECK              UINT32_C(0x01)


/**
 * This flag makes lzma_code() return LZMA_UNSUPPORTED_CHECK if the input
 * stream has an integrity check, but the type of the integrity check is not
 * supported by this liblzma version or build. Such files can still be
 * decoded, but the integrity check cannot be verified.
 */
#define LZMA_TELL_UNSUPPORTED_CHECK     UINT32_C(0x02)


/**
 * This flag makes lzma_code() return LZMA_GET_CHECK as soon as the type
 * of the integrity check is known. The type can then be got with
 * lzma_get_check().
 */
#define LZMA_TELL_ANY_CHECK             UINT32_C(0x04)


/**
 * This flag makes lzma_code() not calculate and verify the integrity check
 * of the compressed data in .xz files. This means that invalid integrity
 * check values won't be detected and LZMA_DATA_ERROR won't be returned in
 * such cases.
 *
 * This flag only affects the checks of the compressed data itself; the CRC32
 * values in the .xz headers will still be verified normally.
 *
 * Don't use this flag unless you know what you are doing. Possible reasons
 * to use this flag:
 *
 *   - Trying to recover data from a corrupt .xz file.
 *
 *   - Speeding up decompression, which matters mostly with SHA-256
 *     or with files that have compressed extremely well. It's recommended
 *     to not use this flag for this purpose unless the file integrity is
 *     verified externally in some other way.
 *
 * Support for this flag was added in liblzma 5.1.4beta.
 */
#define LZMA_IGNORE_CHECK               UINT32_C(0x10)


/**
 * This flag enables decoding of concatenated files with file formats that
 * allow concatenating compressed files as is. From the formats currently
 * supported by liblzma, only the .xz and .lz formats allow concatenated
 * files. Concatenated files are not allowed with the legacy .lzma format.
 *
 * This flag also affects the usage of the 'action' argument for lzma_code().
 * When LZMA_CONCATENATED is used, lzma_code() won't return LZMA_STREAM_END
 * unless LZMA_FINISH is used as 'action'. Thus, the application has to set
 * LZMA_FINISH in the same way as it does when encoding.
 *
 * If LZMA_CONCATENATED is not used, the decoders still accept LZMA_FINISH
 * as 'action' for lzma_code(), but the usage of LZMA_FINISH isn't required.
 */
#define LZMA_CONCATENATED               UINT32_C(0x08)


/**
 * This flag makes the threaded decoder report errors (like LZMA_DATA_ERROR)
 * as soon as they are detected. This saves time when the application has no
 * interest in a partially decompressed truncated or corrupt file. Note that
 * due to timing randomness, if the same truncated or corrupt input is
 * decompressed multiple times with this flag, a different amount of output
 * may be produced by different runs, and even the error code might vary.
 *
 * When using LZMA_FAIL_FAST, it is recommended to use LZMA_FINISH to tell
 * the decoder when no more input will be coming because it can help fast
 * detection and reporting of truncated files. Note that in this situation
 * truncated files might be diagnosed with LZMA_DATA_ERROR instead of
 * LZMA_OK or LZMA_BUF_ERROR!
 *
 * Without this flag the threaded decoder will provide as much output as
 * possible at first and then report the pending error. This default behavior
 * matches the single-threaded decoder and provides repeatable behavior
 * with truncated or corrupt input. There are a few special cases where the
 * behavior can still differ like memory allocation failures (LZMA_MEM_ERROR).
 *
 * Single-threaded decoders currently ignore this flag.
 *
 * Support for this flag was added in liblzma 5.3.3alpha. Note that in older
 * versions this flag isn't supported (LZMA_OPTIONS_ERROR) even by functions
 * that ignore this flag in newer liblzma versions.
 */
#define LZMA_FAIL_FAST                  UINT32_C(0x20)


/**
 * \brief       Initialize .xz Stream decoder
 *
 * \param       strm        Pointer to lzma_stream that is at least initialized
 *                          with LZMA_STREAM_INIT.
 * \param       memlimit    Memory usage limit as bytes. Use UINT64_MAX
 *                          to effectively disable the limiter. liblzma
 *                          5.2.3 and earlier don't allow 0 here and return
 *                          LZMA_PROG_ERROR; later versions treat 0 as if 1
 *                          had been specified.
 * \param       flags       Bitwise-or of zero or more of the decoder flags:
 *                          LZMA_TELL_NO_CHECK, LZMA_TELL_UNSUPPORTED_CHECK,
 *                          LZMA_TELL_ANY_CHECK, LZMA_IGNORE_CHECK,
 *                          LZMA_CONCATENATED, LZMA_FAIL_FAST
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Initialization was successful.
 *              - LZMA_MEM_ERROR: Cannot allocate memory.
 *              - LZMA_OPTIONS_ERROR: Unsupported flags
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_stream_decoder(
		lzma_stream *strm, uint64_t memlimit, uint32_t flags)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Initialize multithreaded .xz Stream decoder
 *
 * The decoder can decode multiple Blocks in parallel. This requires that each
 * Block Header contains the Compressed Size and Uncompressed size fields
 * which are added by the multi-threaded encoder, see lzma_stream_encoder_mt().
 *
 * A Stream with one Block will only utilize one thread. A Stream with multiple
 * Blocks but without size information in Block Headers will be processed in
 * single-threaded mode in the same way as done by lzma_stream_decoder().
 * Concatenated Streams are processed one Stream at a time; no inter-Stream
 * parallelization is done.
 *
 * This function behaves like lzma_stream_decoder() when options->threads == 1
 * and options->memlimit_threading <= 1.
 *
 * \param       strm        Pointer to lzma_stream that is at least initialized
 *                          with LZMA_STREAM_INIT.
 * \param       options     Pointer to multithreaded compression options
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Initialization was successful.
 *              - LZMA_MEM_ERROR: Cannot allocate memory.
 *              - LZMA_MEMLIMIT_ERROR: Memory usage limit was reached.
 *              - LZMA_OPTIONS_ERROR: Unsupported flags.
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_stream_decoder_mt(
		lzma_stream *strm, const lzma_mt *options)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Decode .xz, .lzma, and .lz (lzip) files with autodetection
 *
 * This decoder autodetects between the .xz, .lzma, and .lz file formats,
 * and calls lzma_stream_decoder(), lzma_alone_decoder(), or
 * lzma_lzip_decoder() once the type of the input file has been detected.
 *
 * Support for .lz was added in 5.4.0.
 *
 * If the flag LZMA_CONCATENATED is used and the input is a .lzma file:
 * For historical reasons concatenated .lzma files aren't supported.
 * If there is trailing data after one .lzma stream, lzma_code() will
 * return LZMA_DATA_ERROR. (lzma_alone_decoder() doesn't have such a check
 * as it doesn't support any decoder flags. It will return LZMA_STREAM_END
 * after one .lzma stream.)
 *
 * \param       strm        Pointer to lzma_stream that is at least initialized
 *                          with LZMA_STREAM_INIT.
 * \param       memlimit    Memory usage limit as bytes. Use UINT64_MAX
 *                          to effectively disable the limiter. liblzma
 *                          5.2.3 and earlier don't allow 0 here and return
 *                          LZMA_PROG_ERROR; later versions treat 0 as if 1
 *                          had been specified.
 * \param       flags       Bitwise-or of zero or more of the decoder flags:
 *                          LZMA_TELL_NO_CHECK, LZMA_TELL_UNSUPPORTED_CHECK,
 *                          LZMA_TELL_ANY_CHECK, LZMA_IGNORE_CHECK,
 *                          LZMA_CONCATENATED, LZMA_FAIL_FAST
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Initialization was successful.
 *              - LZMA_MEM_ERROR: Cannot allocate memory.
 *              - LZMA_OPTIONS_ERROR: Unsupported flags
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_auto_decoder(
		lzma_stream *strm, uint64_t memlimit, uint32_t flags)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Initialize .lzma decoder (legacy file format)
 *
 * Valid 'action' arguments to lzma_code() are LZMA_RUN and LZMA_FINISH.
 * There is no need to use LZMA_FINISH, but it's allowed because it may
 * simplify certain types of applications.
 *
 * \param       strm        Pointer to lzma_stream that is at least initialized
 *                          with LZMA_STREAM_INIT.
 * \param       memlimit    Memory usage limit as bytes. Use UINT64_MAX
 *                          to effectively disable the limiter. liblzma
 *                          5.2.3 and earlier don't allow 0 here and return
 *                          LZMA_PROG_ERROR; later versions treat 0 as if 1
 *                          had been specified.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_alone_decoder(
		lzma_stream *strm, uint64_t memlimit)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Initialize .lz (lzip) decoder (a foreign file format)
 *
 * This decoder supports the .lz format versions 0 and 1:
 *
 *   - Files in the format version 0 were produced by lzip 1.3 and older.
 *     Such files aren't common but may be found from file archives
 *     as a few source packages were released in this format. People
 *     might have old personal files in this format too. Decompression
 *     support for the format version 0 was removed in lzip 1.18.
 *
 *   - lzip 1.3 added decompression support for .lz format version 1 files.
 *     Compression support was added in lzip 1.4.
 *
 *   - lzlib extends version 1 format with the Sync Flush marker. This
 *     extension is only meant for lzlib use; it's not valid in normal .lz
 *     files. This extension is not supported by liblzma. lzma_code() will
 *     return LZMA_DATA_ERROR at the location of the Sync Flush marker.
 *
 * Just like with lzma_stream_decoder() for .xz files, LZMA_CONCATENATED
 * should be used when decompressing normal standalone .lz files.
 *
 * If LZMA_CONCATENATED is used and there is non-.lz data after at least one
 * valid .lz member, lzma_code() leaves lzma_stream.next_in pointing to the
 * first byte of the non-.lz data and returns LZMA_STREAM_END. That is, one
 * can append custom data at the end of a .lz file and the decoder will
 * ignore it. An exception to this is if the first 1-3 bytes of the non-.lz
 * data are identical to the .lz magic bytes (0x4C, 0x5A, 0x49, 0x50; "LZIP"
 * in US-ASCII). In such a case the 1-3 bytes are consumed by lzma_code().
 * If one wishes to locate the non-.lz data reliably, one must ensure that
 * the first byte isn't 0x4C. It's best if none of the first four bytes of
 * trailing data are equal to the magic bytes because if two or three bytes
 * are, lzip >= 1.20 diagnoses it as a corrupt member header by default.
 *
 * \param       strm        Pointer to lzma_stream that is at least initialized
 *                          with LZMA_STREAM_INIT.
 * \param       memlimit    Memory usage limit as bytes. Use UINT64_MAX
 *                          to effectively disable the limiter.
 * \param       flags       Bitwise-or of flags, or zero for no flags.
 *                          All decoder flags listed above are supported
 *                          although only LZMA_CONCATENATED and (in very rare
 *                          cases) LZMA_IGNORE_CHECK are actually useful.
 *                          LZMA_TELL_NO_CHECK, LZMA_TELL_UNSUPPORTED_CHECK,
 *                          and LZMA_FAIL_FAST do nothing. LZMA_TELL_ANY_CHECK
 *                          is supported for consistency only as CRC32 is
 *                          always used in the .lz format.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Initialization was successful.
 *              - LZMA_MEM_ERROR: Cannot allocate memory.
 *              - LZMA_OPTIONS_ERROR: Unsupported flags
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_lzip_decoder(
		lzma_stream *strm, uint64_t memlimit, uint32_t flags)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Single-call .xz Stream decoder
 *
 * \param       memlimit    Pointer to how much memory the decoder is allowed
 *                          to allocate. The value pointed by this pointer is
 *                          modified if and only if LZMA_MEMLIMIT_ERROR is
 *                          returned.
 * \param       flags       Bitwise-or of zero or more of the decoder flags:
 *                          LZMA_TELL_NO_CHECK, LZMA_TELL_UNSUPPORTED_CHECK,
 *                          LZMA_IGNORE_CHECK, LZMA_CONCATENATED,
 *                          LZMA_FAIL_FAST. Note that LZMA_TELL_ANY_CHECK
 *                          is not allowed and will return LZMA_PROG_ERROR.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 * \param       in          Beginning of the input buffer
 * \param       in_pos      The next byte will be read from in[*in_pos].
 *                          *in_pos is updated only if decoding succeeds.
 * \param       in_size     Size of the input buffer; the first byte that
 *                          won't be read is in[in_size].
 * \param[out]  out         Beginning of the output buffer
 * \param[out]  out_pos     The next byte will be written to out[*out_pos].
 *                          *out_pos is updated only if decoding succeeds.
 * \param       out_size    Size of the out buffer; the first byte into
 *                          which no data is written to is out[out_size].
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Decoding was successful.
 *              - LZMA_FORMAT_ERROR
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_DATA_ERROR
 *              - LZMA_NO_CHECK: This can be returned only if using
 *                the LZMA_TELL_NO_CHECK flag.
 *              - LZMA_UNSUPPORTED_CHECK: This can be returned only if using
 *                the LZMA_TELL_UNSUPPORTED_CHECK flag.
 *              - LZMA_MEM_ERROR
 *              - LZMA_MEMLIMIT_ERROR: Memory usage limit was reached.
 *                The minimum required memlimit value was stored to *memlimit.
 *              - LZMA_BUF_ERROR: Output buffer was too small.
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_stream_buffer_decode(
		uint64_t *memlimit, uint32_t flags,
		const lzma_allocator *allocator,
		const uint8_t *in, size_t *in_pos, size_t in_size,
		uint8_t *out, size_t *out_pos, size_t out_size)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       MicroLZMA decoder
 *
 * See lzma_microlzma_encoder() for more information.
 *
 * The lzma_code() usage with this decoder is completely normal. The
 * special behavior of lzma_code() applies to lzma_microlzma_encoder() only.
 *
 * \param       strm        Pointer to lzma_stream that is at least initialized
 *                          with LZMA_STREAM_INIT.
 * \param       comp_size   Compressed size of the MicroLZMA stream.
 *                          The caller must somehow know this exactly.
 * \param       uncomp_size Uncompressed size of the MicroLZMA stream.
 *                          If the exact uncompressed size isn't known, this
 *                          can be set to a value that is at most as big as
 *                          the exact uncompressed size would be, but then the
 *                          next argument uncomp_size_is_exact must be false.
 * \param       uncomp_size_is_exact
 *                          If true, uncomp_size must be exactly correct.
 *                          This will improve error detection at the end of
 *                          the stream. If the exact uncompressed size isn't
 *                          known, this must be false. uncomp_size must still
 *                          be at most as big as the exact uncompressed size
 *                          is. Setting this to false when the exact size is
 *                          known will work but error detection at the end of
 *                          the stream will be weaker.
 * \param       dict_size   LZMA dictionary size that was used when
 *                          compressing the data. It is OK to use a bigger
 *                          value too but liblzma will then allocate more
 *                          memory than would actually be required and error
 *                          detection will be slightly worse. (Note that with
 *                          the implementation in XZ Embedded it doesn't
 *                          affect the memory usage if one specifies bigger
 *                          dictionary than actually required.)
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_microlzma_decoder(
		lzma_stream *strm, uint64_t comp_size,
		uint64_t uncomp_size, lzma_bool uncomp_size_is_exact,
		uint32_t dict_size) lzma_nothrow;
