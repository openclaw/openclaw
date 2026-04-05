/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/index.h
 * \brief       Handling of .xz Index and related information
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/**
 * \brief       Opaque data type to hold the Index(es) and other information
 *
 * lzma_index often holds just one .xz Index and possibly the Stream Flags
 * of the same Stream and size of the Stream Padding field. However,
 * multiple lzma_indexes can be concatenated with lzma_index_cat() and then
 * there may be information about multiple Streams in the same lzma_index.
 *
 * Notes about thread safety: Only one thread may modify lzma_index at
 * a time. All functions that take non-const pointer to lzma_index
 * modify it. As long as no thread is modifying the lzma_index, getting
 * information from the same lzma_index can be done from multiple threads
 * at the same time with functions that take a const pointer to
 * lzma_index or use lzma_index_iter. The same iterator must be used
 * only by one thread at a time, of course, but there can be as many
 * iterators for the same lzma_index as needed.
 */
typedef struct lzma_index_s lzma_index;


/**
 * \brief       Iterator to get information about Blocks and Streams
 */
typedef struct {
	struct {
		/**
		 * \brief       Pointer to Stream Flags
		 *
		 * This is NULL if Stream Flags have not been set for
		 * this Stream with lzma_index_stream_flags().
		 */
		const lzma_stream_flags *flags;

		/** \private     Reserved member. */
		const void *reserved_ptr1;

		/** \private     Reserved member. */
		const void *reserved_ptr2;

		/** \private     Reserved member. */
		const void *reserved_ptr3;

		/**
		 * \brief       Stream number in the lzma_index
		 *
		 * The first Stream is 1.
		 */
		lzma_vli number;

		/**
		 * \brief       Number of Blocks in the Stream
		 *
		 * If this is zero, the block structure below has
		 * undefined values.
		 */
		lzma_vli block_count;

		/**
		 * \brief       Compressed start offset of this Stream
		 *
		 * The offset is relative to the beginning of the lzma_index
		 * (i.e. usually the beginning of the .xz file).
		 */
		lzma_vli compressed_offset;

		/**
		 * \brief       Uncompressed start offset of this Stream
		 *
		 * The offset is relative to the beginning of the lzma_index
		 * (i.e. usually the beginning of the .xz file).
		 */
		lzma_vli uncompressed_offset;

		/**
		 * \brief       Compressed size of this Stream
		 *
		 * This includes all headers except the possible
		 * Stream Padding after this Stream.
		 */
		lzma_vli compressed_size;

		/**
		 * \brief       Uncompressed size of this Stream
		 */
		lzma_vli uncompressed_size;

		/**
		 * \brief       Size of Stream Padding after this Stream
		 *
		 * If it hasn't been set with lzma_index_stream_padding(),
		 * this defaults to zero. Stream Padding is always
		 * a multiple of four bytes.
		 */
		lzma_vli padding;


		/** \private     Reserved member. */
		lzma_vli reserved_vli1;

		/** \private     Reserved member. */
		lzma_vli reserved_vli2;

		/** \private     Reserved member. */
		lzma_vli reserved_vli3;

		/** \private     Reserved member. */
		lzma_vli reserved_vli4;
	} stream;

	struct {
		/**
		 * \brief       Block number in the file
		 *
		 * The first Block is 1.
		 */
		lzma_vli number_in_file;

		/**
		 * \brief       Compressed start offset of this Block
		 *
		 * This offset is relative to the beginning of the
		 * lzma_index (i.e. usually the beginning of the .xz file).
		 * Normally this is where you should seek in the .xz file
		 * to start decompressing this Block.
		 */
		lzma_vli compressed_file_offset;

		/**
		 * \brief       Uncompressed start offset of this Block
		 *
		 * This offset is relative to the beginning of the lzma_index
		 * (i.e. usually the beginning of the .xz file).
		 *
		 * When doing random-access reading, it is possible that
		 * the target offset is not exactly at Block boundary. One
		 * will need to compare the target offset against
		 * uncompressed_file_offset or uncompressed_stream_offset,
		 * and possibly decode and throw away some amount of data
		 * before reaching the target offset.
		 */
		lzma_vli uncompressed_file_offset;

		/**
		 * \brief       Block number in this Stream
		 *
		 * The first Block is 1.
		 */
		lzma_vli number_in_stream;

		/**
		 * \brief       Compressed start offset of this Block
		 *
		 * This offset is relative to the beginning of the Stream
		 * containing this Block.
		 */
		lzma_vli compressed_stream_offset;

		/**
		 * \brief       Uncompressed start offset of this Block
		 *
		 * This offset is relative to the beginning of the Stream
		 * containing this Block.
		 */
		lzma_vli uncompressed_stream_offset;

		/**
		 * \brief       Uncompressed size of this Block
		 *
		 * You should pass this to the Block decoder if you will
		 * decode this Block. It will allow the Block decoder to
		 * validate the uncompressed size.
		 */
		lzma_vli uncompressed_size;

		/**
		 * \brief       Unpadded size of this Block
		 *
		 * You should pass this to the Block decoder if you will
		 * decode this Block. It will allow the Block decoder to
		 * validate the unpadded size.
		 */
		lzma_vli unpadded_size;

		/**
		 * \brief       Total compressed size
		 *
		 * This includes all headers and padding in this Block.
		 * This is useful if you need to know how many bytes
		 * the Block decoder will actually read.
		 */
		lzma_vli total_size;

		/** \private     Reserved member. */
		lzma_vli reserved_vli1;

		/** \private     Reserved member. */
		lzma_vli reserved_vli2;

		/** \private     Reserved member. */
		lzma_vli reserved_vli3;

		/** \private     Reserved member. */
		lzma_vli reserved_vli4;

		/** \private     Reserved member. */
		const void *reserved_ptr1;

		/** \private     Reserved member. */
		const void *reserved_ptr2;

		/** \private     Reserved member. */
		const void *reserved_ptr3;

		/** \private     Reserved member. */
		const void *reserved_ptr4;
	} block;

	/**
	 * \private     Internal data
	 *
	 * Internal data which is used to store the state of the iterator.
	 * The exact format may vary between liblzma versions, so don't
	 * touch these in any way.
	 */
	union {
		/** \private     Internal member. */
		const void *p;

		/** \private     Internal member. */
		size_t s;

		/** \private     Internal member. */
		lzma_vli v;
	} internal[6];
} lzma_index_iter;


/**
 * \brief       Operation mode for lzma_index_iter_next()
 */
typedef enum {
	LZMA_INDEX_ITER_ANY             = 0,
		/**<
		 * \brief       Get the next Block or Stream
		 *
		 * Go to the next Block if the current Stream has at least
		 * one Block left. Otherwise go to the next Stream even if
		 * it has no Blocks. If the Stream has no Blocks
		 * (lzma_index_iter.stream.block_count == 0),
		 * lzma_index_iter.block will have undefined values.
		 */

	LZMA_INDEX_ITER_STREAM          = 1,
		/**<
		 * \brief       Get the next Stream
		 *
		 * Go to the next Stream even if the current Stream has
		 * unread Blocks left. If the next Stream has at least one
		 * Block, the iterator will point to the first Block.
		 * If there are no Blocks, lzma_index_iter.block will have
		 * undefined values.
		 */

	LZMA_INDEX_ITER_BLOCK           = 2,
		/**<
		 * \brief       Get the next Block
		 *
		 * Go to the next Block if the current Stream has at least
		 * one Block left. If the current Stream has no Blocks left,
		 * the next Stream with at least one Block is located and
		 * the iterator will be made to point to the first Block of
		 * that Stream.
		 */

	LZMA_INDEX_ITER_NONEMPTY_BLOCK  = 3
		/**<
		 * \brief       Get the next non-empty Block
		 *
		 * This is like LZMA_INDEX_ITER_BLOCK except that it will
		 * skip Blocks whose Uncompressed Size is zero.
		 */

} lzma_index_iter_mode;


/**
 * \brief       Mask for return value from lzma_index_checks() for check none
 *
 * \note        This and the other CHECK_MASK macros were added in 5.5.1alpha.
 */
#define LZMA_INDEX_CHECK_MASK_NONE (UINT32_C(1) << LZMA_CHECK_NONE)

/**
 * \brief       Mask for return value from lzma_index_checks() for check CRC32
 */
#define LZMA_INDEX_CHECK_MASK_CRC32 (UINT32_C(1) << LZMA_CHECK_CRC32)

/**
 * \brief       Mask for return value from lzma_index_checks() for check CRC64
 */
#define LZMA_INDEX_CHECK_MASK_CRC64 (UINT32_C(1) << LZMA_CHECK_CRC64)

/**
 * \brief       Mask for return value from lzma_index_checks() for check SHA256
 */
#define LZMA_INDEX_CHECK_MASK_SHA256 (UINT32_C(1) << LZMA_CHECK_SHA256)

/**
 * \brief       Calculate memory usage of lzma_index
 *
 * On disk, the size of the Index field depends on both the number of Records
 * stored and the size of the Records (due to variable-length integer
 * encoding). When the Index is kept in lzma_index structure, the memory usage
 * depends only on the number of Records/Blocks stored in the Index(es), and
 * in case of concatenated lzma_indexes, the number of Streams. The size in
 * RAM is almost always significantly bigger than in the encoded form on disk.
 *
 * This function calculates an approximate amount of memory needed to hold
 * the given number of Streams and Blocks in lzma_index structure. This
 * value may vary between CPU architectures and also between liblzma versions
 * if the internal implementation is modified.
 *
 * \param       streams Number of Streams
 * \param       blocks  Number of Blocks
 *
 * \return      Approximate memory in bytes needed in a lzma_index structure.
 */
extern LZMA_API(uint64_t) lzma_index_memusage(
		lzma_vli streams, lzma_vli blocks) lzma_nothrow;


/**
 * \brief       Calculate the memory usage of an existing lzma_index
 *
 * This is a shorthand for lzma_index_memusage(lzma_index_stream_count(i),
 * lzma_index_block_count(i)).
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Approximate memory in bytes used by the lzma_index structure.
 */
extern LZMA_API(uint64_t) lzma_index_memused(const lzma_index *i)
		lzma_nothrow;


/**
 * \brief       Allocate and initialize a new lzma_index structure
 *
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 *
 * \return      On success, a pointer to an empty initialized lzma_index is
 *              returned. If allocation fails, NULL is returned.
 */
extern LZMA_API(lzma_index *) lzma_index_init(const lzma_allocator *allocator)
		lzma_nothrow;


/**
 * \brief       Deallocate lzma_index
 *
 * If i is NULL, this does nothing.
 *
 * \param       i           Pointer to lzma_index structure to deallocate
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 */
extern LZMA_API(void) lzma_index_end(
		lzma_index *i, const lzma_allocator *allocator) lzma_nothrow;


/**
 * \brief       Add a new Block to lzma_index
 *
 * \param       i                 Pointer to a lzma_index structure
 * \param       allocator         lzma_allocator for custom allocator
 *                                functions. Set to NULL to use malloc()
 *                                and free().
 * \param       unpadded_size     Unpadded Size of a Block. This can be
 *                                calculated with lzma_block_unpadded_size()
 *                                after encoding or decoding the Block.
 * \param       uncompressed_size Uncompressed Size of a Block. This can be
 *                                taken directly from lzma_block structure
 *                                after encoding or decoding the Block.
 *
 * Appending a new Block does not invalidate iterators. For example,
 * if an iterator was pointing to the end of the lzma_index, after
 * lzma_index_append() it is possible to read the next Block with
 * an existing iterator.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_DATA_ERROR: Compressed or uncompressed size of the
 *                Stream or size of the Index field would grow too big.
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_index_append(
		lzma_index *i, const lzma_allocator *allocator,
		lzma_vli unpadded_size, lzma_vli uncompressed_size)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Set the Stream Flags
 *
 * Set the Stream Flags of the last (and typically the only) Stream
 * in lzma_index. This can be useful when reading information from the
 * lzma_index, because to decode Blocks, knowing the integrity check type
 * is needed.
 *
 * \param       i              Pointer to lzma_index structure
 * \param       stream_flags   Pointer to lzma_stream_flags structure. This
 *                             is copied into the internal preallocated
 *                             structure, so the caller doesn't need to keep
 *                             the flags' data available after calling this
 *                             function.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_OPTIONS_ERROR: Unsupported stream_flags->version.
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_index_stream_flags(
		lzma_index *i, const lzma_stream_flags *stream_flags)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Get the types of integrity Checks
 *
 * If lzma_index_stream_flags() is used to set the Stream Flags for
 * every Stream, lzma_index_checks() can be used to get a bitmask to
 * indicate which Check types have been used. It can be useful e.g. if
 * showing the Check types to the user.
 *
 * The bitmask is 1 << check_id, e.g. CRC32 is 1 << 1 and SHA-256 is 1 << 10.
 * These masks are defined for convenience as LZMA_INDEX_CHECK_MASK_XXX
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Bitmask indicating which Check types are used in the lzma_index
 */
extern LZMA_API(uint32_t) lzma_index_checks(const lzma_index *i)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Set the amount of Stream Padding
 *
 * Set the amount of Stream Padding of the last (and typically the only)
 * Stream in the lzma_index. This is needed when planning to do random-access
 * reading within multiple concatenated Streams.
 *
 * By default, the amount of Stream Padding is assumed to be zero bytes.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_DATA_ERROR: The file size would grow too big.
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_index_stream_padding(
		lzma_index *i, lzma_vli stream_padding)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Get the number of Streams
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Number of Streams in the lzma_index
 */
extern LZMA_API(lzma_vli) lzma_index_stream_count(const lzma_index *i)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Get the number of Blocks
 *
 * This returns the total number of Blocks in lzma_index. To get number
 * of Blocks in individual Streams, use lzma_index_iter.
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Number of blocks in the lzma_index
 */
extern LZMA_API(lzma_vli) lzma_index_block_count(const lzma_index *i)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Get the size of the Index field as bytes
 *
 * This is needed to verify the Backward Size field in the Stream Footer.
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Size in bytes of the Index
 */
extern LZMA_API(lzma_vli) lzma_index_size(const lzma_index *i)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Get the total size of the Stream
 *
 * If multiple lzma_indexes have been combined, this works as if the Blocks
 * were in a single Stream. This is useful if you are going to combine
 * Blocks from multiple Streams into a single new Stream.
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Size in bytes of the Stream (if all Blocks are combined
 *              into one Stream).
 */
extern LZMA_API(lzma_vli) lzma_index_stream_size(const lzma_index *i)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Get the total size of the Blocks
 *
 * This doesn't include the Stream Header, Stream Footer, Stream Padding,
 * or Index fields.
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Size in bytes of all Blocks in the Stream(s)
 */
extern LZMA_API(lzma_vli) lzma_index_total_size(const lzma_index *i)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Get the total size of the file
 *
 * When no lzma_indexes have been combined with lzma_index_cat() and there is
 * no Stream Padding, this function is identical to lzma_index_stream_size().
 * If multiple lzma_indexes have been combined, this includes also the headers
 * of each separate Stream and the possible Stream Padding fields.
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Total size of the .xz file in bytes
 */
extern LZMA_API(lzma_vli) lzma_index_file_size(const lzma_index *i)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Get the uncompressed size of the file
 *
 * \param       i   Pointer to lzma_index structure
 *
 * \return      Size in bytes of the uncompressed data in the file
 */
extern LZMA_API(lzma_vli) lzma_index_uncompressed_size(const lzma_index *i)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Initialize an iterator
 *
 * This function associates the iterator with the given lzma_index, and calls
 * lzma_index_iter_rewind() on the iterator.
 *
 * This function doesn't allocate any memory, thus there is no
 * lzma_index_iter_end(). The iterator is valid as long as the
 * associated lzma_index is valid, that is, until lzma_index_end() or
 * using it as source in lzma_index_cat(). Specifically, lzma_index doesn't
 * become invalid if new Blocks are added to it with lzma_index_append() or
 * if it is used as the destination in lzma_index_cat().
 *
 * It is safe to make copies of an initialized lzma_index_iter, for example,
 * to easily restart reading at some particular position.
 *
 * \param       iter    Pointer to a lzma_index_iter structure
 * \param       i       lzma_index to which the iterator will be associated
 */
extern LZMA_API(void) lzma_index_iter_init(
		lzma_index_iter *iter, const lzma_index *i) lzma_nothrow;


/**
 * \brief       Rewind the iterator
 *
 * Rewind the iterator so that next call to lzma_index_iter_next() will
 * return the first Block or Stream.
 *
 * \param       iter    Pointer to a lzma_index_iter structure
 */
extern LZMA_API(void) lzma_index_iter_rewind(lzma_index_iter *iter)
		lzma_nothrow;


/**
 * \brief       Get the next Block or Stream
 *
 * \param       iter    Iterator initialized with lzma_index_iter_init()
 * \param       mode    Specify what kind of information the caller wants
 *                      to get. See lzma_index_iter_mode for details.
 *
 * \return      lzma_bool:
 *              - true if no Block or Stream matching the mode is found.
 *                *iter is not updated (failure).
 *              - false if the next Block or Stream matching the mode was
 *                found. *iter is updated (success).
 */
extern LZMA_API(lzma_bool) lzma_index_iter_next(
		lzma_index_iter *iter, lzma_index_iter_mode mode)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Locate a Block
 *
 * If it is possible to seek in the .xz file, it is possible to parse
 * the Index field(s) and use lzma_index_iter_locate() to do random-access
 * reading with granularity of Block size.
 *
 * If the target is smaller than the uncompressed size of the Stream (can be
 * checked with lzma_index_uncompressed_size()):
 *  - Information about the Stream and Block containing the requested
 *    uncompressed offset is stored into *iter.
 *  - Internal state of the iterator is adjusted so that
 *    lzma_index_iter_next() can be used to read subsequent Blocks or Streams.
 *
 * If the target is greater than the uncompressed size of the Stream, *iter
 * is not modified.
 *
 * \param       iter    Iterator that was earlier initialized with
 *                      lzma_index_iter_init().
 * \param       target  Uncompressed target offset which the caller would
 *                      like to locate from the Stream
 *
 * \return      lzma_bool:
 *              - true if the target is greater than or equal to the
 *                uncompressed size of the Stream (failure)
 *              - false if the target is smaller than the uncompressed size
 *                of the Stream (success)
 */
extern LZMA_API(lzma_bool) lzma_index_iter_locate(
		lzma_index_iter *iter, lzma_vli target) lzma_nothrow;


/**
 * \brief       Concatenate lzma_indexes
 *
 * Concatenating lzma_indexes is useful when doing random-access reading in
 * multi-Stream .xz file, or when combining multiple Streams into single
 * Stream.
 *
 * \param[out]  dest      lzma_index after which src is appended
 * \param       src       lzma_index to be appended after dest. If this
 *                        function succeeds, the memory allocated for src
 *                        is freed or moved to be part of dest, and all
 *                        iterators pointing to src will become invalid.
 * \param       allocator lzma_allocator for custom allocator functions.
 *                        Set to NULL to use malloc() and free().
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: lzma_indexes were concatenated successfully.
 *                src is now a dangling pointer.
 *              - LZMA_DATA_ERROR: *dest would grow too big.
 *              - LZMA_MEM_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_index_cat(lzma_index *dest, lzma_index *src,
		const lzma_allocator *allocator)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Duplicate lzma_index
 *
 * \param       i         Pointer to lzma_index structure to be duplicated
 * \param       allocator lzma_allocator for custom allocator functions.
 *                        Set to NULL to use malloc() and free().
 *
 * \return      A copy of the lzma_index, or NULL if memory allocation failed.
 */
extern LZMA_API(lzma_index *) lzma_index_dup(
		const lzma_index *i, const lzma_allocator *allocator)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Initialize .xz Index encoder
 *
 * \param       strm        Pointer to properly prepared lzma_stream
 * \param       i           Pointer to lzma_index which should be encoded.
 *
 * The valid 'action' values for lzma_code() are LZMA_RUN and LZMA_FINISH.
 * It is enough to use only one of them (you can choose freely).
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Initialization succeeded, continue with lzma_code().
 *              - LZMA_MEM_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_index_encoder(
		lzma_stream *strm, const lzma_index *i)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Initialize .xz Index decoder
 *
 * \param       strm        Pointer to properly prepared lzma_stream
 * \param[out]  i           The decoded Index will be made available via
 *                          this pointer. Initially this function will
 *                          set *i to NULL (the old value is ignored). If
 *                          decoding succeeds (lzma_code() returns
 *                          LZMA_STREAM_END), *i will be set to point
 *                          to a new lzma_index, which the application
 *                          has to later free with lzma_index_end().
 * \param       memlimit    How much memory the resulting lzma_index is
 *                          allowed to require. liblzma 5.2.3 and earlier
 *                          don't allow 0 here and return LZMA_PROG_ERROR;
 *                          later versions treat 0 as if 1 had been specified.
 *
 * Valid 'action' arguments to lzma_code() are LZMA_RUN and LZMA_FINISH.
 * There is no need to use LZMA_FINISH, but it's allowed because it may
 * simplify certain types of applications.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Initialization succeeded, continue with lzma_code().
 *              - LZMA_MEM_ERROR
 *              - LZMA_PROG_ERROR
 *
 * \note        liblzma 5.2.3 and older list also LZMA_MEMLIMIT_ERROR here
 *              but that error code has never been possible from this
 *              initialization function.
 */
extern LZMA_API(lzma_ret) lzma_index_decoder(
		lzma_stream *strm, lzma_index **i, uint64_t memlimit)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Single-call .xz Index encoder
 *
 * \note        This function doesn't take allocator argument since all
 *              the internal data is allocated on stack.
 *
 * \param       i         lzma_index to be encoded
 * \param[out]  out       Beginning of the output buffer
 * \param[out]  out_pos   The next byte will be written to out[*out_pos].
 *                        *out_pos is updated only if encoding succeeds.
 * \param       out_size  Size of the out buffer; the first byte into
 *                        which no data is written to is out[out_size].
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Encoding was successful.
 *              - LZMA_BUF_ERROR: Output buffer is too small. Use
 *                lzma_index_size() to find out how much output
 *                space is needed.
 *              - LZMA_PROG_ERROR
 *
 */
extern LZMA_API(lzma_ret) lzma_index_buffer_encode(const lzma_index *i,
		uint8_t *out, size_t *out_pos, size_t out_size) lzma_nothrow;


/**
 * \brief       Single-call .xz Index decoder
 *
 * \param[out]  i           If decoding succeeds, *i will point to a new
 *                          lzma_index, which the application has to
 *                          later free with lzma_index_end(). If an error
 *                          occurs, *i will be NULL. The old value of *i
 *                          is always ignored and thus doesn't need to be
 *                          initialized by the caller.
 * \param[out]  memlimit    Pointer to how much memory the resulting
 *                          lzma_index is allowed to require. The value
 *                          pointed by this pointer is modified if and only
 *                          if LZMA_MEMLIMIT_ERROR is returned.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 * \param       in          Beginning of the input buffer
 * \param       in_pos      The next byte will be read from in[*in_pos].
 *                          *in_pos is updated only if decoding succeeds.
 * \param       in_size     Size of the input buffer; the first byte that
 *                          won't be read is in[in_size].
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Decoding was successful.
 *              - LZMA_MEM_ERROR
 *              - LZMA_MEMLIMIT_ERROR: Memory usage limit was reached.
 *                The minimum required memlimit value was stored to *memlimit.
 *              - LZMA_DATA_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_index_buffer_decode(lzma_index **i,
		uint64_t *memlimit, const lzma_allocator *allocator,
		const uint8_t *in, size_t *in_pos, size_t in_size)
		lzma_nothrow;


/**
 * \brief       Initialize a .xz file information decoder
 *
 * This decoder decodes the Stream Header, Stream Footer, Index, and
 * Stream Padding field(s) from the input .xz file and stores the resulting
 * combined index in *dest_index. This information can be used to get the
 * uncompressed file size with lzma_index_uncompressed_size(*dest_index) or,
 * for example, to implement random access reading by locating the Blocks
 * in the Streams.
 *
 * To get the required information from the .xz file, lzma_code() may ask
 * the application to seek in the input file by returning LZMA_SEEK_NEEDED
 * and having the target file position specified in lzma_stream.seek_pos.
 * The number of seeks required depends on the input file and how big buffers
 * the application provides. When possible, the decoder will seek backward
 * and forward in the given buffer to avoid useless seek requests. Thus, if
 * the application provides the whole file at once, no external seeking will
 * be required (that is, lzma_code() won't return LZMA_SEEK_NEEDED).
 *
 * The value in lzma_stream.total_in can be used to estimate how much data
 * liblzma had to read to get the file information. However, due to seeking
 * and the way total_in is updated, the value of total_in will be somewhat
 * inaccurate (a little too big). Thus, total_in is a good estimate but don't
 * expect to see the same exact value for the same file if you change the
 * input buffer size or switch to a different liblzma version.
 *
 * Valid 'action' arguments to lzma_code() are LZMA_RUN and LZMA_FINISH.
 * You only need to use LZMA_RUN; LZMA_FINISH is only supported because it
 * might be convenient for some applications. If you use LZMA_FINISH and if
 * lzma_code() asks the application to seek, remember to reset 'action' back
 * to LZMA_RUN unless you hit the end of the file again.
 *
 * Possible return values from lzma_code():
 *   - LZMA_OK: All OK so far, more input needed
 *   - LZMA_SEEK_NEEDED: Provide more input starting from the absolute
 *     file position strm->seek_pos
 *   - LZMA_STREAM_END: Decoding was successful, *dest_index has been set
 *   - LZMA_FORMAT_ERROR: The input file is not in the .xz format (the
 *     expected magic bytes were not found from the beginning of the file)
 *   - LZMA_OPTIONS_ERROR: File looks valid but contains headers that aren't
 *     supported by this version of liblzma
 *   - LZMA_DATA_ERROR: File is corrupt
 *   - LZMA_BUF_ERROR
 *   - LZMA_MEM_ERROR
 *   - LZMA_MEMLIMIT_ERROR
 *   - LZMA_PROG_ERROR
 *
 * \param       strm        Pointer to a properly prepared lzma_stream
 * \param[out]  dest_index  Pointer to a pointer where the decoder will put
 *                          the decoded lzma_index. The old value
 *                          of *dest_index is ignored (not freed).
 * \param       memlimit    How much memory the resulting lzma_index is
 *                          allowed to require. Use UINT64_MAX to
 *                          effectively disable the limiter.
 * \param       file_size   Size of the input .xz file
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_file_info_decoder(
		lzma_stream *strm, lzma_index **dest_index,
		uint64_t memlimit, uint64_t file_size)
		lzma_nothrow;
