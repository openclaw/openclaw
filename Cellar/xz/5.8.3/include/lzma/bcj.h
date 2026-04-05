/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/bcj.h
 * \brief       Branch/Call/Jump conversion filters
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/* Filter IDs for lzma_filter.id */

/**
 * \brief       Filter for x86 binaries
 */
#define LZMA_FILTER_X86         LZMA_VLI_C(0x04)

/**
 * \brief       Filter for Big endian PowerPC binaries
 */
#define LZMA_FILTER_POWERPC     LZMA_VLI_C(0x05)

/**
 * \brief       Filter for IA-64 (Itanium) binaries
 */
#define LZMA_FILTER_IA64        LZMA_VLI_C(0x06)

/**
 * \brief       Filter for ARM binaries
 */
#define LZMA_FILTER_ARM         LZMA_VLI_C(0x07)

/**
 * \brief       Filter for ARM-Thumb binaries
 */
#define LZMA_FILTER_ARMTHUMB    LZMA_VLI_C(0x08)

/**
 * \brief       Filter for SPARC binaries
 */
#define LZMA_FILTER_SPARC       LZMA_VLI_C(0x09)

/**
 * \brief       Filter for ARM64 binaries
 */
#define LZMA_FILTER_ARM64       LZMA_VLI_C(0x0A)

/**
 * \brief       Filter for RISC-V binaries
 */
#define LZMA_FILTER_RISCV       LZMA_VLI_C(0x0B)


/**
 * \brief       Options for BCJ filters
 *
 * The BCJ filters never change the size of the data. Specifying options
 * for them is optional: if pointer to options is NULL, default value is
 * used. You probably never need to specify options to BCJ filters, so just
 * set the options pointer to NULL and be happy.
 *
 * If options with non-default values have been specified when encoding,
 * the same options must also be specified when decoding.
 *
 * \note        At the moment, none of the BCJ filters support
 *              LZMA_SYNC_FLUSH. If LZMA_SYNC_FLUSH is specified,
 *              LZMA_OPTIONS_ERROR will be returned. If there is need,
 *              partial support for LZMA_SYNC_FLUSH can be added in future.
 *              Partial means that flushing would be possible only at
 *              offsets that are multiple of 2, 4, or 16 depending on
 *              the filter, except x86 which cannot be made to support
 *              LZMA_SYNC_FLUSH predictably.
 */
typedef struct {
	/**
	 * \brief       Start offset for conversions
	 *
	 * This setting is useful only when the same filter is used
	 * _separately_ for multiple sections of the same executable file,
	 * and the sections contain cross-section branch/call/jump
	 * instructions. In that case it is beneficial to set the start
	 * offset of the non-first sections so that the relative addresses
	 * of the cross-section branch/call/jump instructions will use the
	 * same absolute addresses as in the first section.
	 *
	 * When the pointer to options is NULL, the default value (zero)
	 * is used.
	 */
	uint32_t start_offset;

} lzma_options_bcj;


/**
 * \brief       Raw ARM64 BCJ encoder
 *
 * This is for special use cases only.
 *
 * \param       start_offset  The lowest 32 bits of the offset in the
 *                            executable being filtered. For the ARM64
 *                            filter, this must be a multiple of four.
 *                            For the very best results, this should also
 *                            be in sync with 4096-byte page boundaries
 *                            in the executable due to how ARM64's ADRP
 *                            instruction works.
 * \param       buf           Buffer to be filtered in place
 * \param       size          Size of the buffer
 *
 * \return      Number of bytes that were processed in `buf`. This is at most
 *              `size`. With the ARM64 filter, the return value is always
 *              a multiple of 4, and at most 3 bytes are left unfiltered.
 *
 * \since       5.7.1alpha
 */
extern LZMA_API(size_t) lzma_bcj_arm64_encode(
		uint32_t start_offset, uint8_t *buf, size_t size) lzma_nothrow;

/**
 * \brief       Raw ARM64 BCJ decoder
 *
 * See lzma_bcj_arm64_encode().
 *
 * \since       5.7.1alpha
 */
extern LZMA_API(size_t) lzma_bcj_arm64_decode(
		uint32_t start_offset, uint8_t *buf, size_t size) lzma_nothrow;


/**
 * \brief       Raw RISC-V BCJ encoder
 *
 * This is for special use cases only.
 *
 * \param       start_offset  The lowest 32 bits of the offset in the
 *                            executable being filtered. For the RISC-V
 *                            filter, this must be a multiple of 2.
 * \param       buf           Buffer to be filtered in place
 * \param       size          Size of the buffer
 *
 * \return      Number of bytes that were processed in `buf`. This is at most
 *              `size`. With the RISC-V filter, the return value is always
 *              a multiple of 2, and at most 7 bytes are left unfiltered.
 *
 * \since       5.7.1alpha
 */
extern LZMA_API(size_t) lzma_bcj_riscv_encode(
		uint32_t start_offset, uint8_t *buf, size_t size) lzma_nothrow;

/**
 * \brief       Raw RISC-V BCJ decoder
 *
 * See lzma_bcj_riscv_encode().
 *
 * \since       5.7.1alpha
 */
extern LZMA_API(size_t) lzma_bcj_riscv_decode(
		uint32_t start_offset, uint8_t *buf, size_t size) lzma_nothrow;


/**
 * \brief       Raw x86 BCJ encoder
 *
 * This is for special use cases only.
 *
 * \param       start_offset  The lowest 32 bits of the offset in the
 *                            executable being filtered. For the x86
 *                            filter, all values are valid.
 * \param       buf           Buffer to be filtered in place
 * \param       size          Size of the buffer
 *
 * \return      Number of bytes that were processed in `buf`. This is at most
 *              `size`. For the x86 filter, the return value is always
 *              a multiple of 1, and at most 4 bytes are left unfiltered.
 *
 * \since       5.7.1alpha
 */
extern LZMA_API(size_t) lzma_bcj_x86_encode(
		uint32_t start_offset, uint8_t *buf, size_t size) lzma_nothrow;

/**
 * \brief       Raw x86 BCJ decoder
 *
 * See lzma_bcj_x86_encode().
 *
 * \since       5.7.1alpha
 */
extern LZMA_API(size_t) lzma_bcj_x86_decode(
		uint32_t start_offset, uint8_t *buf, size_t size) lzma_nothrow;
