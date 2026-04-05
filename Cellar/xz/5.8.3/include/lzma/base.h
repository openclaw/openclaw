/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/base.h
 * \brief       Data types and functions used in many places in liblzma API
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/**
 * \brief       Boolean
 *
 * This is here because C89 doesn't have stdbool.h. To set a value for
 * variables having type lzma_bool, you can use
 *   - C99's 'true' and 'false' from stdbool.h;
 *   - C++'s internal 'true' and 'false'; or
 *   - integers one (true) and zero (false).
 */
typedef unsigned char lzma_bool;


/**
 * \brief       Type of reserved enumeration variable in structures
 *
 * To avoid breaking library ABI when new features are added, several
 * structures contain extra variables that may be used in future. Since
 * sizeof(enum) can be different than sizeof(int), and sizeof(enum) may
 * even vary depending on the range of enumeration constants, we specify
 * a separate type to be used for reserved enumeration variables. All
 * enumeration constants in liblzma API will be non-negative and less
 * than 128, which should guarantee that the ABI won't break even when
 * new constants are added to existing enumerations.
 */
typedef enum {
	LZMA_RESERVED_ENUM      = 0
} lzma_reserved_enum;


/**
 * \brief       Return values used by several functions in liblzma
 *
 * Check the descriptions of specific functions to find out which return
 * values they can return. With some functions the return values may have
 * more specific meanings than described here; those differences are
 * described per-function basis.
 */
typedef enum {
	LZMA_OK                 = 0,
		/**<
		 * \brief       Operation completed successfully
		 */

	LZMA_STREAM_END         = 1,
		/**<
		 * \brief       End of stream was reached
		 *
		 * In encoder, LZMA_SYNC_FLUSH, LZMA_FULL_FLUSH, or
		 * LZMA_FINISH was finished. In decoder, this indicates
		 * that all the data was successfully decoded.
		 *
		 * In all cases, when LZMA_STREAM_END is returned, the last
		 * output bytes should be picked from strm->next_out.
		 */

	LZMA_NO_CHECK           = 2,
		/**<
		 * \brief       Input stream has no integrity check
		 *
		 * This return value can be returned only if the
		 * LZMA_TELL_NO_CHECK flag was used when initializing
		 * the decoder. LZMA_NO_CHECK is just a warning, and
		 * the decoding can be continued normally.
		 *
		 * It is possible to call lzma_get_check() immediately after
		 * lzma_code has returned LZMA_NO_CHECK. The result will
		 * naturally be LZMA_CHECK_NONE, but the possibility to call
		 * lzma_get_check() may be convenient in some applications.
		 */

	LZMA_UNSUPPORTED_CHECK  = 3,
		/**<
		 * \brief       Cannot calculate the integrity check
		 *
		 * The usage of this return value is different in encoders
		 * and decoders.
		 *
		 * Encoders can return this value only from the initialization
		 * function. If initialization fails with this value, the
		 * encoding cannot be done, because there's no way to produce
		 * output with the correct integrity check.
		 *
		 * Decoders can return this value only from lzma_code() and
		 * only if the LZMA_TELL_UNSUPPORTED_CHECK flag was used when
		 * initializing the decoder. The decoding can still be
		 * continued normally even if the check type is unsupported,
		 * but naturally the check will not be validated, and possible
		 * errors may go undetected.
		 *
		 * With decoder, it is possible to call lzma_get_check()
		 * immediately after lzma_code() has returned
		 * LZMA_UNSUPPORTED_CHECK. This way it is possible to find
		 * out what the unsupported Check ID was.
		 */

	LZMA_GET_CHECK          = 4,
		/**<
		 * \brief       Integrity check type is now available
		 *
		 * This value can be returned only by the lzma_code() function
		 * and only if the decoder was initialized with the
		 * LZMA_TELL_ANY_CHECK flag. LZMA_GET_CHECK tells the
		 * application that it may now call lzma_get_check() to find
		 * out the Check ID. This can be used, for example, to
		 * implement a decoder that accepts only files that have
		 * strong enough integrity check.
		 */

	LZMA_MEM_ERROR          = 5,
		/**<
		 * \brief       Cannot allocate memory
		 *
		 * Memory allocation failed, or the size of the allocation
		 * would be greater than SIZE_MAX.
		 *
		 * Due to internal implementation reasons, the coding cannot
		 * be continued even if more memory were made available after
		 * LZMA_MEM_ERROR.
		 */

	LZMA_MEMLIMIT_ERROR     = 6,
		/**<
		 * \brief       Memory usage limit was reached
		 *
		 * Decoder would need more memory than allowed by the
		 * specified memory usage limit. To continue decoding,
		 * the memory usage limit has to be increased with
		 * lzma_memlimit_set().
		 *
		 * liblzma 5.2.6 and earlier had a bug in single-threaded .xz
		 * decoder (lzma_stream_decoder()) which made it impossible
		 * to continue decoding after LZMA_MEMLIMIT_ERROR even if
		 * the limit was increased using lzma_memlimit_set().
		 * Other decoders worked correctly.
		 */

	LZMA_FORMAT_ERROR       = 7,
		/**<
		 * \brief       File format not recognized
		 *
		 * The decoder did not recognize the input as supported file
		 * format. This error can occur, for example, when trying to
		 * decode .lzma format file with lzma_stream_decoder,
		 * because lzma_stream_decoder accepts only the .xz format.
		 */

	LZMA_OPTIONS_ERROR      = 8,
		/**<
		 * \brief       Invalid or unsupported options
		 *
		 * Invalid or unsupported options, for example
		 *  - unsupported filter(s) or filter options; or
		 *  - reserved bits set in headers (decoder only).
		 *
		 * Rebuilding liblzma with more features enabled, or
		 * upgrading to a newer version of liblzma may help.
		 */

	LZMA_DATA_ERROR         = 9,
		/**<
		 * \brief       Data is corrupt
		 *
		 * The usage of this return value is different in encoders
		 * and decoders. In both encoder and decoder, the coding
		 * cannot continue after this error.
		 *
		 * Encoders return this if size limits of the target file
		 * format would be exceeded. These limits are huge, thus
		 * getting this error from an encoder is mostly theoretical.
		 * For example, the maximum compressed and uncompressed
		 * size of a .xz Stream is roughly 8 EiB (2^63 bytes).
		 *
		 * Decoders return this error if the input data is corrupt.
		 * This can mean, for example, invalid CRC32 in headers
		 * or invalid check of uncompressed data.
		 */

	LZMA_BUF_ERROR          = 10,
		/**<
		 * \brief       No progress is possible
		 *
		 * This error code is returned when the coder cannot consume
		 * any new input and produce any new output. The most common
		 * reason for this error is that the input stream being
		 * decoded is truncated or corrupt.
		 *
		 * This error is not fatal. Coding can be continued normally
		 * by providing more input and/or more output space, if
		 * possible.
		 *
		 * Typically the first call to lzma_code() that can do no
		 * progress returns LZMA_OK instead of LZMA_BUF_ERROR. Only
		 * the second consecutive call doing no progress will return
		 * LZMA_BUF_ERROR. This is intentional.
		 *
		 * With zlib, Z_BUF_ERROR may be returned even if the
		 * application is doing nothing wrong, so apps will need
		 * to handle Z_BUF_ERROR specially. The above hack
		 * guarantees that liblzma never returns LZMA_BUF_ERROR
		 * to properly written applications unless the input file
		 * is truncated or corrupt. This should simplify the
		 * applications a little.
		 */

	LZMA_PROG_ERROR         = 11,
		/**<
		 * \brief       Programming error
		 *
		 * This indicates that the arguments given to the function are
		 * invalid or the internal state of the decoder is corrupt.
		 *   - Function arguments are invalid or the structures
		 *     pointed by the argument pointers are invalid
		 *     e.g. if strm->next_out has been set to NULL and
		 *     strm->avail_out > 0 when calling lzma_code().
		 *   - lzma_* functions have been called in wrong order
		 *     e.g. lzma_code() was called right after lzma_end().
		 *   - If errors occur randomly, the reason might be flaky
		 *     hardware.
		 *
		 * If you think that your code is correct, this error code
		 * can be a sign of a bug in liblzma. See the documentation
		 * how to report bugs.
		 */

	LZMA_SEEK_NEEDED        = 12,
		/**<
		 * \brief       Request to change the input file position
		 *
		 * Some coders can do random access in the input file. The
		 * initialization functions of these coders take the file size
		 * as an argument. No other coders can return LZMA_SEEK_NEEDED.
		 *
		 * When this value is returned, the application must seek to
		 * the file position given in lzma_stream.seek_pos. This value
		 * is guaranteed to never exceed the file size that was
		 * specified at the coder initialization.
		 *
		 * After seeking the application should read new input and
		 * pass it normally via lzma_stream.next_in and .avail_in.
		 */

	/*
	 * These enumerations may be used internally by liblzma
	 * but they will never be returned to applications.
	 */
	LZMA_RET_INTERNAL1      = 101,
	LZMA_RET_INTERNAL2      = 102,
	LZMA_RET_INTERNAL3      = 103,
	LZMA_RET_INTERNAL4      = 104,
	LZMA_RET_INTERNAL5      = 105,
	LZMA_RET_INTERNAL6      = 106,
	LZMA_RET_INTERNAL7      = 107,
	LZMA_RET_INTERNAL8      = 108
} lzma_ret;


/**
 * \brief       The 'action' argument for lzma_code()
 *
 * After the first use of LZMA_SYNC_FLUSH, LZMA_FULL_FLUSH, LZMA_FULL_BARRIER,
 * or LZMA_FINISH, the same 'action' must be used until lzma_code() returns
 * LZMA_STREAM_END. Also, the amount of input (that is, strm->avail_in) must
 * not be modified by the application until lzma_code() returns
 * LZMA_STREAM_END. Changing the 'action' or modifying the amount of input
 * will make lzma_code() return LZMA_PROG_ERROR.
 */
typedef enum {
	LZMA_RUN = 0,
		/**<
		 * \brief       Continue coding
		 *
		 * Encoder: Encode as much input as possible. Some internal
		 * buffering will probably be done (depends on the filter
		 * chain in use), which causes latency: the input used won't
		 * usually be decodeable from the output of the same
		 * lzma_code() call.
		 *
		 * Decoder: Decode as much input as possible and produce as
		 * much output as possible.
		 */

	LZMA_SYNC_FLUSH = 1,
		/**<
		 * \brief       Make all the input available at output
		 *
		 * Normally the encoder introduces some latency.
		 * LZMA_SYNC_FLUSH forces all the buffered data to be
		 * available at output without resetting the internal
		 * state of the encoder. This way it is possible to use
		 * compressed stream for example for communication over
		 * network.
		 *
		 * Only some filters support LZMA_SYNC_FLUSH. Trying to use
		 * LZMA_SYNC_FLUSH with filters that don't support it will
		 * make lzma_code() return LZMA_OPTIONS_ERROR. For example,
		 * LZMA1 doesn't support LZMA_SYNC_FLUSH but LZMA2 does.
		 *
		 * Using LZMA_SYNC_FLUSH very often can dramatically reduce
		 * the compression ratio. With some filters (for example,
		 * LZMA2), fine-tuning the compression options may help
		 * mitigate this problem significantly (for example,
		 * match finder with LZMA2).
		 *
		 * Decoders don't support LZMA_SYNC_FLUSH.
		 */

	LZMA_FULL_FLUSH = 2,
		/**<
		 * \brief       Finish encoding of the current Block
		 *
		 * All the input data going to the current Block must have
		 * been given to the encoder (the last bytes can still be
		 * pending in *next_in). Call lzma_code() with LZMA_FULL_FLUSH
		 * until it returns LZMA_STREAM_END. Then continue normally
		 * with LZMA_RUN or finish the Stream with LZMA_FINISH.
		 *
		 * This action is currently supported only by Stream encoder
		 * and easy encoder (which uses Stream encoder). If there is
		 * no unfinished Block, no empty Block is created.
		 */

	LZMA_FULL_BARRIER = 4,
		/**<
		 * \brief       Finish encoding of the current Block
		 *
		 * This is like LZMA_FULL_FLUSH except that this doesn't
		 * necessarily wait until all the input has been made
		 * available via the output buffer. That is, lzma_code()
		 * might return LZMA_STREAM_END as soon as all the input
		 * has been consumed (avail_in == 0).
		 *
		 * LZMA_FULL_BARRIER is useful with a threaded encoder if
		 * one wants to split the .xz Stream into Blocks at specific
		 * offsets but doesn't care if the output isn't flushed
		 * immediately. Using LZMA_FULL_BARRIER allows keeping
		 * the threads busy while LZMA_FULL_FLUSH would make
		 * lzma_code() wait until all the threads have finished
		 * until more data could be passed to the encoder.
		 *
		 * With a lzma_stream initialized with the single-threaded
		 * lzma_stream_encoder() or lzma_easy_encoder(),
		 * LZMA_FULL_BARRIER is an alias for LZMA_FULL_FLUSH.
		 */

	LZMA_FINISH = 3
		/**<
		 * \brief       Finish the coding operation
		 *
		 * All the input data must have been given to the encoder
		 * (the last bytes can still be pending in next_in).
		 * Call lzma_code() with LZMA_FINISH until it returns
		 * LZMA_STREAM_END. Once LZMA_FINISH has been used,
		 * the amount of input must no longer be changed by
		 * the application.
		 *
		 * When decoding, using LZMA_FINISH is optional unless the
		 * LZMA_CONCATENATED flag was used when the decoder was
		 * initialized. When LZMA_CONCATENATED was not used, the only
		 * effect of LZMA_FINISH is that the amount of input must not
		 * be changed just like in the encoder.
		 */
} lzma_action;


/**
 * \brief       Custom functions for memory handling
 *
 * A pointer to lzma_allocator may be passed via lzma_stream structure
 * to liblzma, and some advanced functions take a pointer to lzma_allocator
 * as a separate function argument. The library will use the functions
 * specified in lzma_allocator for memory handling instead of the default
 * malloc() and free(). C++ users should note that the custom memory
 * handling functions must not throw exceptions.
 *
 * Single-threaded mode only: liblzma doesn't make an internal copy of
 * lzma_allocator. Thus, it is OK to change these function pointers in
 * the middle of the coding process, but obviously it must be done
 * carefully to make sure that the replacement 'free' can deallocate
 * memory allocated by the earlier 'alloc' function(s).
 *
 * Multithreaded mode: liblzma might internally store pointers to the
 * lzma_allocator given via the lzma_stream structure. The application
 * must not change the allocator pointer in lzma_stream or the contents
 * of the pointed lzma_allocator structure until lzma_end() has been used
 * to free the memory associated with that lzma_stream. The allocation
 * functions might be called simultaneously from multiple threads, and
 * thus they must be thread safe.
 */
typedef struct {
	/**
	 * \brief       Pointer to a custom memory allocation function
	 *
	 * If you don't want a custom allocator, but still want
	 * custom free(), set this to NULL and liblzma will use
	 * the standard malloc().
	 *
	 * \param       opaque  lzma_allocator.opaque (see below)
	 * \param       nmemb   Number of elements like in calloc(). liblzma
	 *                      will always set nmemb to 1, so it is safe to
	 *                      ignore nmemb in a custom allocator if you like.
	 *                      The nmemb argument exists only for
	 *                      compatibility with zlib and libbzip2.
	 * \param       size    Size of an element in bytes.
	 *                      liblzma never sets this to zero.
	 *
	 * \return      Pointer to the beginning of a memory block of
	 *              'size' bytes, or NULL if allocation fails
	 *              for some reason. When allocation fails, functions
	 *              of liblzma return LZMA_MEM_ERROR.
	 *
	 * The allocator should not waste time zeroing the allocated buffers.
	 * This is not only about speed, but also memory usage, since the
	 * operating system kernel doesn't necessarily allocate the requested
	 * memory in physical memory until it is actually used. With small
	 * input files, liblzma may actually need only a fraction of the
	 * memory that it requested for allocation.
	 *
	 * \note        LZMA_MEM_ERROR is also used when the size of the
	 *              allocation would be greater than SIZE_MAX. Thus,
	 *              don't assume that the custom allocator must have
	 *              returned NULL if some function from liblzma
	 *              returns LZMA_MEM_ERROR.
	 */
	void *(LZMA_API_CALL *alloc)(void *opaque, size_t nmemb, size_t size);

	/**
	 * \brief       Pointer to a custom memory freeing function
	 *
	 * If you don't want a custom freeing function, but still
	 * want a custom allocator, set this to NULL and liblzma
	 * will use the standard free().
	 *
	 * \param       opaque  lzma_allocator.opaque (see below)
	 * \param       ptr     Pointer returned by lzma_allocator.alloc(),
	 *                      or when it is set to NULL, a pointer returned
	 *                      by the standard malloc(). In addition, NULL
	 *                      is a possible value. The function should do
	 *                      nothing when ptr == NULL.
	 */
	void (LZMA_API_CALL *free)(void *opaque, void *ptr);

	/**
	 * \brief       Pointer passed to .alloc() and .free()
	 *
	 * opaque is passed as the first argument to lzma_allocator.alloc()
	 * and lzma_allocator.free(). This intended to ease implementing
	 * custom memory allocation functions for use with liblzma.
	 *
	 * If you don't need this, you should set this to NULL.
	 */
	void *opaque;

} lzma_allocator;


/**
 * \brief       Internal data structure
 *
 * The contents of this structure is not visible outside the library.
 */
typedef struct lzma_internal_s lzma_internal;


/**
 * \brief       Passing data to and from liblzma
 *
 * The lzma_stream structure is used for
 *  - passing pointers to input and output buffers to liblzma;
 *  - defining custom memory handler functions; and
 *  - holding a pointer to coder-specific internal data structures.
 *
 * Typical usage:
 *
 *  - After allocating lzma_stream (on stack or with malloc()), it must be
 *    initialized to LZMA_STREAM_INIT (see LZMA_STREAM_INIT for details).
 *
 *  - Initialize a coder to the lzma_stream, for example by using
 *    lzma_easy_encoder() or lzma_auto_decoder(). Some notes:
 *      - In contrast to zlib, strm->next_in and strm->next_out are
 *        ignored by all initialization functions, thus it is safe
 *        to not initialize them yet.
 *      - The initialization functions always set strm->total_in and
 *        strm->total_out to zero.
 *      - If the initialization function fails, no memory is left allocated
 *        that would require freeing with lzma_end() even if some memory was
 *        associated with the lzma_stream structure when the initialization
 *        function was called.
 *
 *  - Use lzma_code() to do the actual work.
 *
 *  - Once the coding has been finished, the existing lzma_stream can be
 *    reused. It is OK to reuse lzma_stream with different initialization
 *    function without calling lzma_end() first. Old allocations are
 *    automatically freed.
 *
 *  - Finally, use lzma_end() to free the allocated memory. lzma_end() never
 *    frees the lzma_stream structure itself.
 *
 * Application may modify the values of total_in and total_out as it wants.
 * They are updated by liblzma to match the amount of data read and
 * written but aren't used for anything else except as a possible return
 * values from lzma_get_progress().
 */
typedef struct {
	const uint8_t *next_in; /**< Pointer to the next input byte. */
	size_t avail_in;    /**< Number of available input bytes in next_in. */
	uint64_t total_in;  /**< Total number of bytes read by liblzma. */

	uint8_t *next_out;  /**< Pointer to the next output position. */
	size_t avail_out;   /**< Amount of free space in next_out. */
	uint64_t total_out; /**< Total number of bytes written by liblzma. */

	/**
	 * \brief       Custom memory allocation functions
	 *
	 * In most cases this is NULL which makes liblzma use
	 * the standard malloc() and free().
	 *
	 * \note        In 5.0.x this is not a const pointer.
	 */
	const lzma_allocator *allocator;

	/** Internal state is not visible to applications. */
	lzma_internal *internal;

	/*
	 * Reserved space to allow possible future extensions without
	 * breaking the ABI. Excluding the initialization of this structure,
	 * you should not touch these, because the names of these variables
	 * may change.
	 */

	/** \private     Reserved member. */
	void *reserved_ptr1;

	/** \private     Reserved member. */
	void *reserved_ptr2;

	/** \private     Reserved member. */
	void *reserved_ptr3;

	/** \private     Reserved member. */
	void *reserved_ptr4;

	/**
	 * \brief       New seek input position for LZMA_SEEK_NEEDED
	 *
	 * When lzma_code() returns LZMA_SEEK_NEEDED, the new input position
	 * needed by liblzma will be available in seek_pos. The value is
	 * guaranteed to not exceed the file size that was specified when
	 * this lzma_stream was initialized.
	 *
	 * In all other situations the value of this variable is undefined.
	 */
	uint64_t seek_pos;

	/** \private     Reserved member. */
	uint64_t reserved_int2;

	/** \private     Reserved member. */
	size_t reserved_int3;

	/** \private     Reserved member. */
	size_t reserved_int4;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum1;

	/** \private     Reserved member. */
	lzma_reserved_enum reserved_enum2;

} lzma_stream;


/**
 * \brief       Initialization for lzma_stream
 *
 * When you declare an instance of lzma_stream, you can immediately
 * initialize it so that initialization functions know that no memory
 * has been allocated yet:
 *
 *     lzma_stream strm = LZMA_STREAM_INIT;
 *
 * If you need to initialize a dynamically allocated lzma_stream, you can use
 * memset(strm_pointer, 0, sizeof(lzma_stream)). Strictly speaking, this
 * violates the C standard since NULL may have different internal
 * representation than zero, but it should be portable enough in practice.
 * Anyway, for maximum portability, you can use something like this:
 *
 *     lzma_stream tmp = LZMA_STREAM_INIT;
 *     *strm = tmp;
 */
#define LZMA_STREAM_INIT \
	{ NULL, 0, 0, NULL, 0, 0, NULL, NULL, \
	NULL, NULL, NULL, NULL, 0, 0, 0, 0, \
	LZMA_RESERVED_ENUM, LZMA_RESERVED_ENUM }


/**
 * \brief       Encode or decode data
 *
 * Once the lzma_stream has been successfully initialized (e.g. with
 * lzma_stream_encoder()), the actual encoding or decoding is done
 * using this function. The application has to update strm->next_in,
 * strm->avail_in, strm->next_out, and strm->avail_out to pass input
 * to and get output from liblzma.
 *
 * See the description of the coder-specific initialization function to find
 * out what 'action' values are supported by the coder.
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 * \param       action  Action for this function to take. Must be a valid
 *                      lzma_action enum value.
 *
 * \return      Any valid lzma_ret. See the lzma_ret enum description for more
 *              information.
 */
extern LZMA_API(lzma_ret) lzma_code(lzma_stream *strm, lzma_action action)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Free memory allocated for the coder data structures
 *
 * After lzma_end(strm), strm->internal is guaranteed to be NULL. No other
 * members of the lzma_stream structure are touched.
 *
 * \note        zlib indicates an error if application end()s unfinished
 *              stream structure. liblzma doesn't do this, and assumes that
 *              application knows what it is doing.
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 */
extern LZMA_API(void) lzma_end(lzma_stream *strm) lzma_nothrow;


/**
 * \brief       Get progress information
 *
 * In single-threaded mode, applications can get progress information from
 * strm->total_in and strm->total_out. In multi-threaded mode this is less
 * useful because a significant amount of both input and output data gets
 * buffered internally by liblzma. This makes total_in and total_out give
 * misleading information and also makes the progress indicator updates
 * non-smooth.
 *
 * This function gives realistic progress information also in multi-threaded
 * mode by taking into account the progress made by each thread. In
 * single-threaded mode *progress_in and *progress_out are set to
 * strm->total_in and strm->total_out, respectively.
 *
 * \param       strm          Pointer to lzma_stream that is at least
 *                            initialized with LZMA_STREAM_INIT.
 * \param[out]  progress_in   Pointer to the number of input bytes processed.
 * \param[out]  progress_out  Pointer to the number of output bytes processed.
 */
extern LZMA_API(void) lzma_get_progress(lzma_stream *strm,
		uint64_t *progress_in, uint64_t *progress_out) lzma_nothrow;


/**
 * \brief       Get the memory usage of decoder filter chain
 *
 * This function is currently supported only when *strm has been initialized
 * with a function that takes a memlimit argument. With other functions, you
 * should use e.g. lzma_raw_encoder_memusage() or lzma_raw_decoder_memusage()
 * to estimate the memory requirements.
 *
 * This function is useful e.g. after LZMA_MEMLIMIT_ERROR to find out how big
 * the memory usage limit should have been to decode the input. Note that
 * this may give misleading information if decoding .xz Streams that have
 * multiple Blocks, because each Block can have different memory requirements.
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 *
 * \return      How much memory is currently allocated for the filter
 *              decoders. If no filter chain is currently allocated,
 *              some non-zero value is still returned, which is less than
 *              or equal to what any filter chain would indicate as its
 *              memory requirement.
 *
 *              If this function isn't supported by *strm or some other error
 *              occurs, zero is returned.
 */
extern LZMA_API(uint64_t) lzma_memusage(const lzma_stream *strm)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Get the current memory usage limit
 *
 * This function is supported only when *strm has been initialized with
 * a function that takes a memlimit argument.
 *
 * \param       strm    Pointer to lzma_stream that is at least initialized
 *                      with LZMA_STREAM_INIT.
 *
 * \return      On success, the current memory usage limit is returned
 *              (always non-zero). On error, zero is returned.
 */
extern LZMA_API(uint64_t) lzma_memlimit_get(const lzma_stream *strm)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Set the memory usage limit
 *
 * This function is supported only when *strm has been initialized with
 * a function that takes a memlimit argument.
 *
 * liblzma 5.2.3 and earlier has a bug where memlimit value of 0 causes
 * this function to do nothing (leaving the limit unchanged) and still
 * return LZMA_OK. Later versions treat 0 as if 1 had been specified (so
 * lzma_memlimit_get() will return 1 even if you specify 0 here).
 *
 * liblzma 5.2.6 and earlier had a bug in single-threaded .xz decoder
 * (lzma_stream_decoder()) which made it impossible to continue decoding
 * after LZMA_MEMLIMIT_ERROR even if the limit was increased using
 * lzma_memlimit_set(). Other decoders worked correctly.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: New memory usage limit successfully set.
 *              - LZMA_MEMLIMIT_ERROR: The new limit is too small.
 *                The limit was not changed.
 *              - LZMA_PROG_ERROR: Invalid arguments, e.g. *strm doesn't
 *                support memory usage limit.
 */
extern LZMA_API(lzma_ret) lzma_memlimit_set(
		lzma_stream *strm, uint64_t memlimit) lzma_nothrow;
