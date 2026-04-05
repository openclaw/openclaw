/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/filter.h
 * \brief       Common filter related types and functions
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/**
 * \brief       Maximum number of filters in a chain
 *
 * A filter chain can have 1-4 filters, of which three are allowed to change
 * the size of the data. Usually only one or two filters are needed.
 */
#define LZMA_FILTERS_MAX 4


/**
 * \brief       Filter options
 *
 * This structure is used to pass a Filter ID and a pointer to the filter's
 * options to liblzma. A few functions work with a single lzma_filter
 * structure, while most functions expect a filter chain.
 *
 * A filter chain is indicated with an array of lzma_filter structures.
 * The array is terminated with .id = LZMA_VLI_UNKNOWN. Thus, the filter
 * array must have LZMA_FILTERS_MAX + 1 elements (that is, five) to
 * be able to hold any arbitrary filter chain. This is important when
 * using lzma_block_header_decode() from block.h, because a filter array
 * that is too small would make liblzma write past the end of the array.
 */
typedef struct {
	/**
	 * \brief       Filter ID
	 *
	 * Use constants whose name begin with 'LZMA_FILTER_' to specify
	 * different filters. In an array of lzma_filter structures, use
	 * LZMA_VLI_UNKNOWN to indicate end of filters.
	 *
	 * \note        This is not an enum, because on some systems enums
	 *              cannot be 64-bit.
	 */
	lzma_vli id;

	/**
	 * \brief       Pointer to filter-specific options structure
	 *
	 * If the filter doesn't need options, set this to NULL. If id is
	 * set to LZMA_VLI_UNKNOWN, options is ignored, and thus
	 * doesn't need be initialized.
	 */
	void *options;

} lzma_filter;


/**
 * \brief       Test if the given Filter ID is supported for encoding
 *
 * \param       id      Filter ID
 *
 * \return      lzma_bool:
 *              - true if the Filter ID is supported for encoding by this
 *                liblzma build.
  *             - false otherwise.
 */
extern LZMA_API(lzma_bool) lzma_filter_encoder_is_supported(lzma_vli id)
		lzma_nothrow lzma_attr_const;


/**
 * \brief       Test if the given Filter ID is supported for decoding
 *
 * \param       id      Filter ID
 *
 * \return      lzma_bool:
 *              - true if the Filter ID is supported for decoding by this
 *                liblzma build.
 *              - false otherwise.
 */
extern LZMA_API(lzma_bool) lzma_filter_decoder_is_supported(lzma_vli id)
		lzma_nothrow lzma_attr_const;


/**
 * \brief       Copy the filters array
 *
 * Copy the Filter IDs and filter-specific options from src to dest.
 * Up to LZMA_FILTERS_MAX filters are copied, plus the terminating
 * .id == LZMA_VLI_UNKNOWN. Thus, dest should have at least
 * LZMA_FILTERS_MAX + 1 elements space unless the caller knows that
 * src is smaller than that.
 *
 * Unless the filter-specific options is NULL, the Filter ID has to be
 * supported by liblzma, because liblzma needs to know the size of every
 * filter-specific options structure. The filter-specific options are not
 * validated. If options is NULL, any unsupported Filter IDs are copied
 * without returning an error.
 *
 * Old filter-specific options in dest are not freed, so dest doesn't
 * need to be initialized by the caller in any way.
 *
 * If an error occurs, memory possibly already allocated by this function
 * is always freed. liblzma versions older than 5.2.7 may modify the dest
 * array and leave its contents in an undefined state if an error occurs.
 * liblzma 5.2.7 and newer only modify the dest array when returning LZMA_OK.
 *
 * \param       src         Array of filters terminated with
 *                          .id == LZMA_VLI_UNKNOWN.
 * \param[out]  dest        Destination filter array
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_OPTIONS_ERROR: Unsupported Filter ID and its options
 *                is not NULL.
 *              - LZMA_PROG_ERROR: src or dest is NULL.
 */
extern LZMA_API(lzma_ret) lzma_filters_copy(
		const lzma_filter *src, lzma_filter *dest,
		const lzma_allocator *allocator)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Free the options in the array of lzma_filter structures
 *
 * This frees the filter chain options. The filters array itself is not freed.
 *
 * The filters array must have at most LZMA_FILTERS_MAX + 1 elements
 * including the terminating element which must have .id = LZMA_VLI_UNKNOWN.
 * For all elements before the terminating element:
 *   - options will be freed using the given lzma_allocator or,
 *     if allocator is NULL, using free().
 *   - options will be set to NULL.
 *   - id will be set to LZMA_VLI_UNKNOWN.
 *
 * If filters is NULL, this does nothing. Again, this never frees the
 * filters array itself.
 *
 * \param       filters     Array of filters terminated with
 *                          .id == LZMA_VLI_UNKNOWN.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 */
extern LZMA_API(void) lzma_filters_free(
		lzma_filter *filters, const lzma_allocator *allocator)
		lzma_nothrow;


/**
 * \brief       Calculate approximate memory requirements for raw encoder
 *
 * This function can be used to calculate the memory requirements for
 * Block and Stream encoders too because Block and Stream encoders don't
 * need significantly more memory than raw encoder.
 *
 * \param       filters     Array of filters terminated with
 *                          .id == LZMA_VLI_UNKNOWN.
 *
 * \return      Number of bytes of memory required for the given
 *              filter chain when encoding or UINT64_MAX on error.
 */
extern LZMA_API(uint64_t) lzma_raw_encoder_memusage(const lzma_filter *filters)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Calculate approximate memory requirements for raw decoder
 *
 * This function can be used to calculate the memory requirements for
 * Block and Stream decoders too because Block and Stream decoders don't
 * need significantly more memory than raw decoder.
 *
 * \param       filters     Array of filters terminated with
 *                          .id == LZMA_VLI_UNKNOWN.
 *
 * \return      Number of bytes of memory required for the given
 *              filter chain when decoding or UINT64_MAX on error.
 */
extern LZMA_API(uint64_t) lzma_raw_decoder_memusage(const lzma_filter *filters)
		lzma_nothrow lzma_attr_pure;


/**
 * \brief       Initialize raw encoder
 *
 * This function may be useful when implementing custom file formats.
 *
 * The 'action' with lzma_code() can be LZMA_RUN, LZMA_SYNC_FLUSH (if the
 * filter chain supports it), or LZMA_FINISH.
 *
 * \param       strm      Pointer to lzma_stream that is at least
 *                        initialized with LZMA_STREAM_INIT.
 * \param       filters   Array of filters terminated with
 *                        .id == LZMA_VLI_UNKNOWN.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_raw_encoder(
		lzma_stream *strm, const lzma_filter *filters)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Initialize raw decoder
 *
 * The initialization of raw decoder goes similarly to raw encoder.
 *
 * The 'action' with lzma_code() can be LZMA_RUN or LZMA_FINISH. Using
 * LZMA_FINISH is not required, it is supported just for convenience.
 *
 * \param       strm      Pointer to lzma_stream that is at least
 *                        initialized with LZMA_STREAM_INIT.
 * \param       filters   Array of filters terminated with
 *                        .id == LZMA_VLI_UNKNOWN.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_raw_decoder(
		lzma_stream *strm, const lzma_filter *filters)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Update the filter chain in the encoder
 *
 * This function may be called after lzma_code() has returned LZMA_STREAM_END
 * when LZMA_FULL_BARRIER, LZMA_FULL_FLUSH, or LZMA_SYNC_FLUSH was used:
 *
 *  - After LZMA_FULL_BARRIER or LZMA_FULL_FLUSH: Single-threaded .xz Stream
 *    encoder (lzma_stream_encoder()) and (since liblzma 5.4.0) multi-threaded
 *    Stream encoder (lzma_stream_encoder_mt()) allow setting a new filter
 *    chain to be used for the next Block(s).
 *
 *  - After LZMA_SYNC_FLUSH: Raw encoder (lzma_raw_encoder()),
 *    Block encoder (lzma_block_encoder()), and single-threaded .xz Stream
 *    encoder (lzma_stream_encoder()) allow changing certain filter-specific
 *    options in the middle of encoding. The actual filters in the chain
 *    (Filter IDs) must not be changed! Currently only the lc, lp, and pb
 *    options of LZMA2 (not LZMA1) can be changed this way.
 *
 *  - In the future some filters might allow changing some of their options
 *    without any barrier or flushing but currently such filters don't exist.
 *
 * This function may also be called when no data has been compressed yet
 * although this is rarely useful. In that case, this function will behave
 * as if LZMA_FULL_FLUSH (Stream encoders) or LZMA_SYNC_FLUSH (Raw or Block
 * encoder) had been used right before calling this function.
 *
 * \param       strm      Pointer to lzma_stream that is at least
 *                        initialized with LZMA_STREAM_INIT.
 * \param       filters   Array of filters terminated with
 *                        .id == LZMA_VLI_UNKNOWN.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_MEM_ERROR
 *              - LZMA_MEMLIMIT_ERROR
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_filters_update(
		lzma_stream *strm, const lzma_filter *filters) lzma_nothrow;


/**
 * \brief       Single-call raw encoder
 *
 * \note        There is no function to calculate how big output buffer
 *              would surely be big enough. (lzma_stream_buffer_bound()
 *              works only for lzma_stream_buffer_encode(); raw encoder
 *              won't necessarily meet that bound.)
 *
 * \param       filters     Array of filters terminated with
 *                          .id == LZMA_VLI_UNKNOWN.
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
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_MEM_ERROR
 *              - LZMA_DATA_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_raw_buffer_encode(
		const lzma_filter *filters, const lzma_allocator *allocator,
		const uint8_t *in, size_t in_size, uint8_t *out,
		size_t *out_pos, size_t out_size) lzma_nothrow;


/**
 * \brief       Single-call raw decoder
 *
 * \param       filters     Array of filters terminated with
 *                          .id == LZMA_VLI_UNKNOWN.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 * \param       in          Beginning of the input buffer
 * \param       in_pos      The next byte will be read from in[*in_pos].
 *                          *in_pos is updated only if decoding succeeds.
 * \param       in_size     Size of the input buffer; the first byte that
 *                          won't be read is in[in_size].
 * \param[out]  out         Beginning of the output buffer
 * \param[out]  out_pos     The next byte will be written to out[*out_pos].
 *                          *out_pos is updated only if encoding succeeds.
 * \param       out_size    Size of the out buffer; the first byte into
 *                          which no data is written to is out[out_size].
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Decoding was successful.
 *              - LZMA_BUF_ERROR: Not enough output buffer space.
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_MEM_ERROR
 *              - LZMA_DATA_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_raw_buffer_decode(
		const lzma_filter *filters, const lzma_allocator *allocator,
		const uint8_t *in, size_t *in_pos, size_t in_size,
		uint8_t *out, size_t *out_pos, size_t out_size) lzma_nothrow;


/**
 * \brief       Get the size of the Filter Properties field
 *
 * This function may be useful when implementing custom file formats
 * using the raw encoder and decoder.
 *
 * \note        This function validates the Filter ID, but does not
 *              necessarily validate the options. Thus, it is possible
 *              that this returns LZMA_OK while the following call to
 *              lzma_properties_encode() returns LZMA_OPTIONS_ERROR.
 *
 * \param[out]  size    Pointer to uint32_t to hold the size of the properties
 * \param       filter  Filter ID and options (the size of the properties may
 *                      vary depending on the options)
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_properties_size(
		uint32_t *size, const lzma_filter *filter) lzma_nothrow;


/**
 * \brief       Encode the Filter Properties field
 *
 * \note        Even this function won't validate more options than actually
 *              necessary. Thus, it is possible that encoding the properties
 *              succeeds but using the same options to initialize the encoder
 *              will fail.
 *
 * \note        If lzma_properties_size() indicated that the size
 *              of the Filter Properties field is zero, calling
 *              lzma_properties_encode() is not required, but it
 *              won't do any harm either.
 *
 * \param       filter  Filter ID and options
 * \param[out]  props   Buffer to hold the encoded options. The size of
 *                      the buffer must have been already determined with
 *                      lzma_properties_size().
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_properties_encode(
		const lzma_filter *filter, uint8_t *props) lzma_nothrow;


/**
 * \brief       Decode the Filter Properties field
 *
 * \param       filter      filter->id must have been set to the correct
 *                          Filter ID. filter->options doesn't need to be
 *                          initialized (it's not freed by this function). The
 *                          decoded options will be stored in filter->options;
 *                          it's application's responsibility to free it when
 *                          appropriate. filter->options is set to NULL if
 *                          there are no properties or if an error occurs.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 *                          and in case of an error, also free().
 * \param       props       Input buffer containing the properties.
 * \param       props_size  Size of the properties. This must be the exact
 *                          size; giving too much or too little input will
 *                          return LZMA_OPTIONS_ERROR.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_MEM_ERROR
 */
extern LZMA_API(lzma_ret) lzma_properties_decode(
		lzma_filter *filter, const lzma_allocator *allocator,
		const uint8_t *props, size_t props_size) lzma_nothrow;


/**
 * \brief       Calculate encoded size of a Filter Flags field
 *
 * Knowing the size of Filter Flags is useful to know when allocating
 * memory to hold the encoded Filter Flags.
 *
 * \note        If you need to calculate size of List of Filter Flags,
 *              you need to loop over every lzma_filter entry.
 *
 * \param[out]  size    Pointer to integer to hold the calculated size
 * \param       filter  Filter ID and associated options whose encoded
 *                      size is to be calculated
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: *size set successfully. Note that this doesn't
 *                guarantee that filter->options is valid, thus
 *                lzma_filter_flags_encode() may still fail.
 *              - LZMA_OPTIONS_ERROR: Unknown Filter ID or unsupported options.
 *              - LZMA_PROG_ERROR: Invalid options
 */
extern LZMA_API(lzma_ret) lzma_filter_flags_size(
		uint32_t *size, const lzma_filter *filter)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Encode Filter Flags into given buffer
 *
 * In contrast to some functions, this doesn't allocate the needed buffer.
 * This is due to how this function is used internally by liblzma.
 *
 * \param       filter      Filter ID and options to be encoded
 * \param[out]  out         Beginning of the output buffer
 * \param[out]  out_pos     out[*out_pos] is the next write position. This
 *                          is updated by the encoder.
 * \param       out_size    out[out_size] is the first byte to not write.
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK: Encoding was successful.
 *              - LZMA_OPTIONS_ERROR: Invalid or unsupported options.
 *              - LZMA_PROG_ERROR: Invalid options or not enough output
 *                buffer space (you should have checked it with
 *                lzma_filter_flags_size()).
 */
extern LZMA_API(lzma_ret) lzma_filter_flags_encode(const lzma_filter *filter,
		uint8_t *out, size_t *out_pos, size_t out_size)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Decode Filter Flags from given buffer
 *
 * The decoded result is stored into *filter. The old value of
 * filter->options is not free()d. If anything other than LZMA_OK
 * is returned, filter->options is set to NULL.
 *
 * \param[out]  filter      Destination filter. The decoded Filter ID will
 *                          be stored in filter->id. If options are needed
 *                          they will be allocated and the pointer will be
 *                          stored in filter->options.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 * \param       in          Beginning of the input buffer
 * \param[out]  in_pos      The next byte will be read from in[*in_pos].
 *                          *in_pos is updated only if decoding succeeds.
 * \param       in_size     Size of the input buffer; the first byte that
 *                          won't be read is in[in_size].
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_OPTIONS_ERROR
 *              - LZMA_MEM_ERROR
 *              - LZMA_DATA_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_filter_flags_decode(
		lzma_filter *filter, const lzma_allocator *allocator,
		const uint8_t *in, size_t *in_pos, size_t in_size)
		lzma_nothrow lzma_attr_warn_unused_result;


/***********
 * Strings *
 ***********/

/**
 * \brief       Allow or show all filters
 *
 * By default only the filters supported in the .xz format are accept by
 * lzma_str_to_filters() or shown by lzma_str_list_filters().
 */
#define LZMA_STR_ALL_FILTERS    UINT32_C(0x01)


/**
 * \brief       Do not validate the filter chain in lzma_str_to_filters()
 *
 * By default lzma_str_to_filters() can return an error if the filter chain
 * as a whole isn't usable in the .xz format or in the raw encoder or decoder.
 * With this flag, this validation is skipped. This flag doesn't affect the
 * handling of the individual filter options. To allow non-.xz filters also
 * LZMA_STR_ALL_FILTERS is needed.
 */
#define LZMA_STR_NO_VALIDATION  UINT32_C(0x02)


/**
 * \brief       Stringify encoder options
 *
 * Show the filter-specific options that the encoder will use.
 * This may be useful for verbose diagnostic messages.
 *
 * Note that if options were decoded from .xz headers then the encoder options
 * may be undefined. This flag shouldn't be used in such a situation.
 */
#define LZMA_STR_ENCODER        UINT32_C(0x10)


/**
 * \brief       Stringify decoder options
 *
 * Show the filter-specific options that the decoder will use.
 * This may be useful for showing what filter options were decoded
 * from file headers.
 */
#define LZMA_STR_DECODER        UINT32_C(0x20)


/**
 * \brief       Produce xz-compatible getopt_long() syntax
 *
 * That is, "delta:dist=2 lzma2:dict=4MiB,pb=1,lp=1" becomes
 * "--delta=dist=2 --lzma2=dict=4MiB,pb=1,lp=1".
 *
 * This syntax is compatible with xz 5.0.0 as long as the filters and
 * their options are supported too.
 */
#define LZMA_STR_GETOPT_LONG    UINT32_C(0x40)


/**
 * \brief       Use two dashes "--" instead of a space to separate filters
 *
 * That is, "delta:dist=2 lzma2:pb=1,lp=1" becomes
 * "delta:dist=2--lzma2:pb=1,lp=1". This looks slightly odd but this
 * kind of strings should be usable on the command line without quoting.
 * However, it is possible that future versions with new filter options
 * might produce strings that require shell quoting anyway as the exact
 * set of possible characters isn't frozen for now.
 *
 * It is guaranteed that the single quote (') will never be used in
 * filter chain strings (even if LZMA_STR_NO_SPACES isn't used).
 */
#define LZMA_STR_NO_SPACES      UINT32_C(0x80)


/**
 * \brief       Convert a string to a filter chain
 *
 * This tries to make it easier to write applications that allow users
 * to set custom compression options. This only handles the filter
 * configuration (including presets) but not the number of threads,
 * block size, check type, or memory limits.
 *
 * The input string can be either a preset or a filter chain. Presets
 * begin with a digit 0-9 and may be followed by zero or more flags
 * which are lower-case letters. Currently only "e" is supported, matching
 * LZMA_PRESET_EXTREME. For partial xz command line syntax compatibility,
 * a preset string may start with a single dash "-".
 *
 * A filter chain consists of one or more "filtername:opt1=value1,opt2=value2"
 * strings separated by one or more spaces. Leading and trailing spaces are
 * ignored. All names and values must be lower-case. Extra commas in the
 * option list are ignored. The order of filters is significant: when
 * encoding, the uncompressed input data goes to the leftmost filter first.
 * Normally "lzma2" is the last filter in the chain.
 *
 * If one wishes to avoid spaces, for example, to avoid shell quoting,
 * it is possible to use two dashes "--" instead of spaces to separate
 * the filters.
 *
 * For xz command line compatibility, each filter may be prefixed with
 * two dashes "--" and the colon ":" separating the filter name from
 * the options may be replaced with an equals sign "=".
 *
 * By default, only filters that can be used in the .xz format are accepted.
 * To allow all filters (LZMA1) use the flag LZMA_STR_ALL_FILTERS.
 *
 * By default, very basic validation is done for the filter chain as a whole,
 * for example, that LZMA2 is only used as the last filter in the chain.
 * The validation isn't perfect though and it's possible that this function
 * succeeds but using the filter chain for encoding or decoding will still
 * result in LZMA_OPTIONS_ERROR. To disable this validation, use the flag
 * LZMA_STR_NO_VALIDATION.
 *
 * The available filter names and their options are available via
 * lzma_str_list_filters(). See the xz man page for the description
 * of filter names and options.
 *
 * For command line applications, below is an example how an error message
 * can be displayed. Note the use of an empty string for the field width.
 * If "^" was used there it would create an off-by-one error except at
 * the very beginning of the line.
 *
 * \code{.c}
 * const char *str = ...; // From user
 * lzma_filter filters[LZMA_FILTERS_MAX + 1];
 * int pos;
 * const char *msg = lzma_str_to_filters(str, &pos, filters, 0, NULL);
 * if (msg != NULL) {
 *     printf("%s: Error in XZ compression options:\n", argv[0]);
 *     printf("%s: %s\n", argv[0], str);
 *     printf("%s: %*s^\n", argv[0], errpos, "");
 *     printf("%s: %s\n", argv[0], msg);
 * }
 * \endcode
 *
 * \param       str         User-supplied string describing a preset or
 *                          a filter chain. If a default value is needed and
 *                          you don't know what would be good, use "6" since
 *                          that is the default preset in xz too.
 * \param[out]  error_pos   If this isn't NULL, this value will be set on
 *                          both success and on all errors. This tells the
 *                          location of the error in the string. This is
 *                          an int to make it straightforward to use this
 *                          as printf() field width. The value is guaranteed
 *                          to be in the range [0, INT_MAX] even if strlen(str)
 *                          somehow was greater than INT_MAX.
 * \param[out]  filters     An array of lzma_filter structures. There must
 *                          be LZMA_FILTERS_MAX + 1 (that is, five) elements
 *                          in the array. The old contents are ignored so it
 *                          doesn't need to be initialized. This array is
 *                          modified only if this function returns NULL.
 *                          Once the allocated filter options are no longer
 *                          needed, lzma_filters_free() can be used to free the
 *                          options (it doesn't free the filters array itself).
 * \param       flags       Bitwise-or of zero or more of the flags
 *                          LZMA_STR_ALL_FILTERS and LZMA_STR_NO_VALIDATION.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 *
 * \return      On success, NULL is returned. On error, a statically-allocated
 *              error message is returned which together with the error_pos
 *              should give some idea what is wrong.
 */
extern LZMA_API(const char *) lzma_str_to_filters(
		const char *str, int *error_pos, lzma_filter *filters,
		uint32_t flags, const lzma_allocator *allocator)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       Convert a filter chain to a string
 *
 * Use cases:
 *
 *   - Verbose output showing the full encoder options to the user
 *     (use LZMA_STR_ENCODER in flags)
 *
 *   - Showing the filters and options that are required to decode a file
 *     (use LZMA_STR_DECODER in flags)
 *
 *   - Showing the filter names without any options in informational messages
 *     where the technical details aren't important (no flags). In this case
 *     the .options in the filters array are ignored and may be NULL even if
 *     a filter has a mandatory options structure.
 *
 * Note that even if the filter chain was specified using a preset,
 * the resulting filter chain isn't reversed to a preset. So if you
 * specify "6" to lzma_str_to_filters() then lzma_str_from_filters()
 * will produce a string containing "lzma2".
 *
 * \param[out]  str         On success *str will be set to point to an
 *                          allocated string describing the given filter
 *                          chain. Old value is ignored. On error *str is
 *                          always set to NULL.
 * \param       filters     Array of filters terminated with
 *                          .id == LZMA_VLI_UNKNOWN.
 * \param       flags       Bitwise-or of zero or more of the flags
 *                          LZMA_STR_ENCODER, LZMA_STR_DECODER,
 *                          LZMA_STR_GETOPT_LONG, and LZMA_STR_NO_SPACES.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_OPTIONS_ERROR: Empty filter chain
 *                (filters[0].id == LZMA_VLI_UNKNOWN) or the filter chain
 *                includes a Filter ID that is not supported by this function.
 *              - LZMA_MEM_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_str_from_filters(
		char **str, const lzma_filter *filters, uint32_t flags,
		const lzma_allocator *allocator)
		lzma_nothrow lzma_attr_warn_unused_result;


/**
 * \brief       List available filters and/or their options (for help message)
 *
 * If a filter_id is given then only one line is created which contains the
 * filter name. If LZMA_STR_ENCODER or LZMA_STR_DECODER is used then the
 * options read by the encoder or decoder are printed on the same line.
 *
 * If filter_id is LZMA_VLI_UNKNOWN then all supported .xz-compatible filters
 * are listed:
 *
 *   - If neither LZMA_STR_ENCODER nor LZMA_STR_DECODER is used then
 *     the supported filter names are listed on a single line separated
 *     by spaces.
 *
 *   - If LZMA_STR_ENCODER or LZMA_STR_DECODER is used then filters and
 *     the supported options are listed one filter per line. There won't
 *     be a newline after the last filter.
 *
 *   - If LZMA_STR_ALL_FILTERS is used then the list will include also
 *     those filters that cannot be used in the .xz format (LZMA1).
 *
 * \param       str         On success *str will be set to point to an
 *                          allocated string listing the filters and options.
 *                          Old value is ignored. On error *str is always set
 *                          to NULL.
 * \param       filter_id   Filter ID or LZMA_VLI_UNKNOWN.
 * \param       flags       Bitwise-or of zero or more of the flags
 *                          LZMA_STR_ALL_FILTERS, LZMA_STR_ENCODER,
 *                          LZMA_STR_DECODER, and LZMA_STR_GETOPT_LONG.
 * \param       allocator   lzma_allocator for custom allocator functions.
 *                          Set to NULL to use malloc() and free().
 *
 * \return      Possible lzma_ret values:
 *              - LZMA_OK
 *              - LZMA_OPTIONS_ERROR: Unsupported filter_id or flags
 *              - LZMA_MEM_ERROR
 *              - LZMA_PROG_ERROR
 */
extern LZMA_API(lzma_ret) lzma_str_list_filters(
		char **str, lzma_vli filter_id, uint32_t flags,
		const lzma_allocator *allocator)
		lzma_nothrow lzma_attr_warn_unused_result;
