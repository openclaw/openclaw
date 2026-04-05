// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*
*   Copyright (C) 2000-2012, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
******************************************************************************
*   file name:  ushape.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2000jun29
*   created by: Markus W. Scherer
*/

#ifndef __USHAPE_H__
#define __USHAPE_H__

#include "unicode/utypes.h"

/**
 * \file
 * \brief C API:  Arabic shaping
 * 
 */

/**
 * Shape Arabic text on a character basis.
 *
 * <p>This function performs basic operations for "shaping" Arabic text. It is most
 * useful for use with legacy data formats and legacy display technology
 * (simple terminals). All operations are performed on Unicode characters.</p>
 *
 * <p>Text-based shaping means that some character code points in the text are
 * replaced by others depending on the context. It transforms one kind of text
 * into another. In comparison, modern displays for Arabic text select
 * appropriate, context-dependent font glyphs for each text element, which means
 * that they transform text into a glyph vector.</p>
 *
 * <p>Text transformations are necessary when modern display technology is not
 * available or when text needs to be transformed to or from legacy formats that
 * use "shaped" characters. Since the Arabic script is cursive, connecting
 * adjacent letters to each other, computers select images for each letter based
 * on the surrounding letters. This usually results in four images per Arabic
 * letter: initial, middle, final, and isolated forms. In Unicode, on the other
 * hand, letters are normally stored abstract, and a display system is expected
 * to select the necessary glyphs. (This makes searching and other text
 * processing easier because the same letter has only one code.) It is possible
 * to mimic this with text transformations because there are characters in
 * Unicode that are rendered as letters with a specific shape
 * (or cursive connectivity). They were included for interoperability with
 * legacy systems and codepages, and for unsophisticated display systems.</p>
 *
 * <p>A second kind of text transformations is supported for Arabic digits:
 * For compatibility with legacy codepages that only include European digits,
 * it is possible to replace one set of digits by another, changing the
 * character code points. These operations can be performed for either
 * Arabic-Indic Digits (U+0660...U+0669) or Eastern (Extended) Arabic-Indic
 * digits (U+06f0...U+06f9).</p>
 *
 * <p>Some replacements may result in more or fewer characters (code points).
 * By default, this means that the destination buffer may receive text with a
 * length different from the source length. Some legacy systems rely on the
 * length of the text to be constant. They expect extra spaces to be added
 * or consumed either next to the affected character or at the end of the
 * text.</p>
 *
 * <p>For details about the available operations, see the description of the
 * <code>U_SHAPE_...</code> options.</p>
 *
 * @param source The input text.
 *
 * @param sourceLength The number of UChars in <code>source</code>.
 *
 * @param dest The destination buffer that will receive the results of the
 *             requested operations. It may be <code>NULL</code> only if
 *             <code>destSize</code> is 0. The source and destination must not
 *             overlap.
 *
 * @param destSize The size (capacity) of the destination buffer in UChars.
 *                 If <code>destSize</code> is 0, then no output is produced,
 *                 but the necessary buffer size is returned ("preflighting").
 *
 * @param options This is a 32-bit set of flags that specify the operations
 *                that are performed on the input text. If no error occurs,
 *                then the result will always be written to the destination
 *                buffer.
 *
 * @param pErrorCode must be a valid pointer to an error code value,
 *        which must not indicate a failure before the function call.
 *
 * @return The number of UChars written to the destination buffer.
 *         If an error occurred, then no output was written, or it may be
 *         incomplete. If <code>U_BUFFER_OVERFLOW_ERROR</code> is set, then
 *         the return value indicates the necessary destination buffer size.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_shapeArabic(const UChar *source, int32_t sourceLength,
              UChar *dest, int32_t destSize,
              uint32_t options,
              UErrorCode *pErrorCode);

/**
 * Memory option: allow the result to have a different length than the source.
 * Affects: LamAlef options
 * @stable ICU 2.0
 */
#define U_SHAPE_LENGTH_GROW_SHRINK              0

/**
 * Memory option: allow the result to have a different length than the source.
 * Affects: LamAlef options
 * This option is an alias to U_SHAPE_LENGTH_GROW_SHRINK
 * @stable ICU 4.2
 */
#define U_SHAPE_LAMALEF_RESIZE                  0 

/**
 * Memory option: the result must have the same length as the source.
 * If more room is necessary, then try to consume spaces next to modified characters.
 * @stable ICU 2.0
 */
#define U_SHAPE_LENGTH_FIXED_SPACES_NEAR        1

/**
 * Memory option: the result must have the same length as the source.
 * If more room is necessary, then try to consume spaces next to modified characters.
 * Affects: LamAlef options
 * This option is an alias to U_SHAPE_LENGTH_FIXED_SPACES_NEAR
 * @stable ICU 4.2
 */
#define U_SHAPE_LAMALEF_NEAR                    1 

/**
 * Memory option: the result must have the same length as the source.
 * If more room is necessary, then try to consume spaces at the end of the text.
 * @stable ICU 2.0
 */
#define U_SHAPE_LENGTH_FIXED_SPACES_AT_END      2

/**
 * Memory option: the result must have the same length as the source.
 * If more room is necessary, then try to consume spaces at the end of the text.
 * Affects: LamAlef options
 * This option is an alias to U_SHAPE_LENGTH_FIXED_SPACES_AT_END
 * @stable ICU 4.2
 */
#define U_SHAPE_LAMALEF_END                     2 

/**
 * Memory option: the result must have the same length as the source.
 * If more room is necessary, then try to consume spaces at the beginning of the text.
 * @stable ICU 2.0
 */
#define U_SHAPE_LENGTH_FIXED_SPACES_AT_BEGINNING 3

/**
 * Memory option: the result must have the same length as the source.
 * If more room is necessary, then try to consume spaces at the beginning of the text.
 * Affects: LamAlef options
 * This option is an alias to U_SHAPE_LENGTH_FIXED_SPACES_AT_BEGINNING
 * @stable ICU 4.2
 */
#define U_SHAPE_LAMALEF_BEGIN                    3 


/**
 * Memory option: the result must have the same length as the source.
 * Shaping Mode: For each LAMALEF character found, expand LAMALEF using space at end.
 *               If there is no space at end, use spaces at beginning of the buffer. If there
 *               is no space at beginning of the buffer, use spaces at the near (i.e. the space
 *               after the LAMALEF character).
 *               If there are no spaces found, an error U_NO_SPACE_AVAILABLE (as defined in utypes.h) 
 *               will be set in pErrorCode
 *
 * Deshaping Mode: Perform the same function as the flag equals U_SHAPE_LAMALEF_END. 
 * Affects: LamAlef options
 * @stable ICU 4.2
 */
#define U_SHAPE_LAMALEF_AUTO                     0x10000 

/** Bit mask for memory options. @stable ICU 2.0 */
#define U_SHAPE_LENGTH_MASK                      0x10003 /* Changed old value 3 */


/**
 * Bit mask for LamAlef memory options.
 * @stable ICU 4.2
 */
#define U_SHAPE_LAMALEF_MASK                     0x10003 /* updated */

/** Direction indicator: the source is in logical (keyboard) order. @stable ICU 2.0 */
#define U_SHAPE_TEXT_DIRECTION_LOGICAL          0

/**
 * Direction indicator:
 * the source is in visual RTL order,
 * the rightmost displayed character stored first.
 * This option is an alias to U_SHAPE_TEXT_DIRECTION_LOGICAL
 * @stable ICU 4.2
 */
#define U_SHAPE_TEXT_DIRECTION_VISUAL_RTL       0

/**
 * Direction indicator:
 * the source is in visual LTR order,
 * the leftmost displayed character stored first.
 * @stable ICU 2.0
 */
#define U_SHAPE_TEXT_DIRECTION_VISUAL_LTR       4

/** Bit mask for direction indicators. @stable ICU 2.0 */
#define U_SHAPE_TEXT_DIRECTION_MASK             4


/** Letter shaping option: do not perform letter shaping. @stable ICU 2.0 */
#define U_SHAPE_LETTERS_NOOP                    0

/** Letter shaping option: replace abstract letter characters by "shaped" ones. @stable ICU 2.0 */
#define U_SHAPE_LETTERS_SHAPE                   8

/** Letter shaping option: replace "shaped" letter characters by abstract ones. @stable ICU 2.0 */
#define U_SHAPE_LETTERS_UNSHAPE                 0x10

/**
 * Letter shaping option: replace abstract letter characters by "shaped" ones.
 * The only difference with U_SHAPE_LETTERS_SHAPE is that Tashkeel letters
 * are always "shaped" into the isolated form instead of the medial form
 * (selecting code points from the Arabic Presentation Forms-B block).
 * @stable ICU 2.0
 */
#define U_SHAPE_LETTERS_SHAPE_TASHKEEL_ISOLATED 0x18


/** Bit mask for letter shaping options. @stable ICU 2.0 */
#define U_SHAPE_LETTERS_MASK                        0x18


/** Digit shaping option: do not perform digit shaping. @stable ICU 2.0 */
#define U_SHAPE_DIGITS_NOOP                     0

/**
 * Digit shaping option:
 * Replace European digits (U+0030...) by Arabic-Indic digits.
 * @stable ICU 2.0
 */
#define U_SHAPE_DIGITS_EN2AN                    0x20

/**
 * Digit shaping option:
 * Replace Arabic-Indic digits by European digits (U+0030...).
 * @stable ICU 2.0
 */
#define U_SHAPE_DIGITS_AN2EN                    0x40

/**
 * Digit shaping option:
 * Replace European digits (U+0030...) by Arabic-Indic digits if the most recent
 * strongly directional character is an Arabic letter
 * (<code>u_charDirection()</code> result <code>U_RIGHT_TO_LEFT_ARABIC</code> [AL]).<br>
 * The direction of "preceding" depends on the direction indicator option.
 * For the first characters, the preceding strongly directional character
 * (initial state) is assumed to be not an Arabic letter
 * (it is <code>U_LEFT_TO_RIGHT</code> [L] or <code>U_RIGHT_TO_LEFT</code> [R]).
 * @stable ICU 2.0
 */
#define U_SHAPE_DIGITS_ALEN2AN_INIT_LR          0x60

/**
 * Digit shaping option:
 * Replace European digits (U+0030...) by Arabic-Indic digits if the most recent
 * strongly directional character is an Arabic letter
 * (<code>u_charDirection()</code> result <code>U_RIGHT_TO_LEFT_ARABIC</code> [AL]).<br>
 * The direction of "preceding" depends on the direction indicator option.
 * For the first characters, the preceding strongly directional character
 * (initial state) is assumed to be an Arabic letter.
 * @stable ICU 2.0
 */
#define U_SHAPE_DIGITS_ALEN2AN_INIT_AL          0x80

/** Not a valid option value. May be replaced by a new option. @stable ICU 2.0 */
#define U_SHAPE_DIGITS_RESERVED                 0xa0

/** Bit mask for digit shaping options. @stable ICU 2.0 */
#define U_SHAPE_DIGITS_MASK                     0xe0


/** Digit type option: Use Arabic-Indic digits (U+0660...U+0669). @stable ICU 2.0 */
#define U_SHAPE_DIGIT_TYPE_AN                   0

/** Digit type option: Use Eastern (Extended) Arabic-Indic digits (U+06f0...U+06f9). @stable ICU 2.0 */
#define U_SHAPE_DIGIT_TYPE_AN_EXTENDED          0x100

/** Not a valid option value. May be replaced by a new option. @stable ICU 2.0 */
#define U_SHAPE_DIGIT_TYPE_RESERVED             0x200

/** Bit mask for digit type options. @stable ICU 2.0 */
#define U_SHAPE_DIGIT_TYPE_MASK                 0x300 /* I need to change this from 0x3f00 to 0x300 */

/** 
 * Tashkeel aggregation option:
 * Replaces any combination of U+0651 with one of
 * U+064C, U+064D, U+064E, U+064F, U+0650 with
 * U+FC5E, U+FC5F, U+FC60, U+FC61, U+FC62 consecutively.
 * @stable ICU 3.6
 */
#define U_SHAPE_AGGREGATE_TASHKEEL              0x4000
/** Tashkeel aggregation option: do not aggregate tashkeels. @stable ICU 3.6 */
#define U_SHAPE_AGGREGATE_TASHKEEL_NOOP         0
/** Bit mask for tashkeel aggregation. @stable ICU 3.6 */
#define U_SHAPE_AGGREGATE_TASHKEEL_MASK         0x4000

/** 
 * Presentation form option:
 * Don't replace Arabic Presentation Forms-A and Arabic Presentation Forms-B
 * characters with 0+06xx characters, before shaping.
 * @stable ICU 3.6
 */
#define U_SHAPE_PRESERVE_PRESENTATION           0x8000
/** Presentation form option: 
 * Replace Arabic Presentation Forms-A and Arabic Presentationo Forms-B with 
 * their unshaped correspondents in range 0+06xx, before shaping.
 * @stable ICU 3.6 
 */
#define U_SHAPE_PRESERVE_PRESENTATION_NOOP      0
/** Bit mask for preserve presentation form. @stable ICU 3.6 */
#define U_SHAPE_PRESERVE_PRESENTATION_MASK      0x8000

/* Seen Tail option */ 
/**
 * Memory option: the result must have the same length as the source.
 * Shaping mode: The SEEN family character will expand into two characters using space near 
 *               the SEEN family character(i.e. the space after the character).
 *               If there are no spaces found, an error U_NO_SPACE_AVAILABLE (as defined in utypes.h) 
 *               will be set in pErrorCode
 *
 * De-shaping mode: Any Seen character followed by Tail character will be
 *                  replaced by one cell Seen and a space will replace the Tail.
 * Affects: Seen options
 * @stable ICU 4.2
 */
#define U_SHAPE_SEEN_TWOCELL_NEAR     0x200000

/**
 * Bit mask for Seen memory options. 
 * @stable ICU 4.2
 */
#define U_SHAPE_SEEN_MASK             0x700000

/* YehHamza option */ 
/**
 * Memory option: the result must have the same length as the source.
 * Shaping mode: The YEHHAMZA character will expand into two characters using space near it 
 *              (i.e. the space after the character
 *               If there are no spaces found, an error U_NO_SPACE_AVAILABLE (as defined in utypes.h) 
 *               will be set in pErrorCode
 *
 * De-shaping mode: Any Yeh (final or isolated) character followed by Hamza character will be
 *                  replaced by one cell YehHamza and space will replace the Hamza.
 * Affects: YehHamza options
 * @stable ICU 4.2
 */
#define U_SHAPE_YEHHAMZA_TWOCELL_NEAR      0x1000000


/**
 * Bit mask for YehHamza memory options. 
 * @stable ICU 4.2
 */
#define U_SHAPE_YEHHAMZA_MASK              0x3800000

/* New Tashkeel options */ 
/**
 * Memory option: the result must have the same length as the source.
 * Shaping mode: Tashkeel characters will be replaced by spaces. 
 *               Spaces will be placed at beginning of the buffer
 *
 * De-shaping mode: N/A
 * Affects: Tashkeel options
 * @stable ICU 4.2
 */
#define U_SHAPE_TASHKEEL_BEGIN                      0x40000

/**
 * Memory option: the result must have the same length as the source.
 * Shaping mode: Tashkeel characters will be replaced by spaces. 
 *               Spaces will be placed at end of the buffer
 *
 * De-shaping mode: N/A
 * Affects: Tashkeel options
 * @stable ICU 4.2
 */
#define U_SHAPE_TASHKEEL_END                        0x60000

/**
 * Memory option: allow the result to have a different length than the source.
 * Shaping mode: Tashkeel characters will be removed, buffer length will shrink. 
 * De-shaping mode: N/A 
 *
 * Affect: Tashkeel options
 * @stable ICU 4.2
 */
#define U_SHAPE_TASHKEEL_RESIZE                     0x80000

/**
 * Memory option: the result must have the same length as the source.
 * Shaping mode: Tashkeel characters will be replaced by Tatweel if it is connected to adjacent
 *               characters (i.e. shaped on Tatweel) or replaced by space if it is not connected.
 *
 * De-shaping mode: N/A
 * Affects: YehHamza options
 * @stable ICU 4.2
 */
#define U_SHAPE_TASHKEEL_REPLACE_BY_TATWEEL         0xC0000

/** 
 * Bit mask for Tashkeel replacement with Space or Tatweel memory options. 
 * @stable ICU 4.2
 */
#define U_SHAPE_TASHKEEL_MASK                       0xE0000


/* Space location Control options */ 
/**
 * This option affect the meaning of BEGIN and END options. if this option is not used the default
 * for BEGIN and END will be as following: 
 * The Default (for both Visual LTR, Visual RTL and Logical Text)
 *           1. BEGIN always refers to the start address of physical memory.
 *           2. END always refers to the end address of physical memory.
 *
 * If this option is used it will swap the meaning of BEGIN and END only for Visual LTR text. 
 *
 * The effect on BEGIN and END Memory Options will be as following:
 *    A. BEGIN For Visual LTR text: This will be the beginning (right side) of the visual text(
 *       corresponding to the physical memory address end for Visual LTR text, Same as END in 
 *       default behavior)
 *    B. BEGIN For Logical text: Same as BEGIN in default behavior. 
 *    C. END For Visual LTR text: This will be the end (left side) of the visual text (corresponding
 *       to the physical memory address beginning for Visual LTR text, Same as BEGIN in default behavior.
 *    D. END For Logical text: Same as END in default behavior). 
 * Affects: All LamAlef BEGIN, END and AUTO options.
 * @stable ICU 4.2
 */
#define U_SHAPE_SPACES_RELATIVE_TO_TEXT_BEGIN_END 0x4000000

/**
 * Bit mask for swapping BEGIN and END for Visual LTR text 
 * @stable ICU 4.2
 */
#define U_SHAPE_SPACES_RELATIVE_TO_TEXT_MASK      0x4000000

/**
 * If this option is used, shaping will use the new Unicode code point for TAIL (i.e. 0xFE73). 
 * If this option is not specified (Default), old unofficial Unicode TAIL code point is used (i.e. 0x200B)
 * De-shaping will not use this option as it will always search for both the new Unicode code point for the 
 * TAIL (i.e. 0xFE73) or the old unofficial Unicode TAIL code point (i.e. 0x200B) and de-shape the
 * Seen-Family letter accordingly.
 *
 * Shaping Mode: Only shaping.
 * De-shaping Mode: N/A.
 * Affects: All Seen options
 * @stable ICU 4.8
 */
#define U_SHAPE_TAIL_NEW_UNICODE        0x8000000

/**
 * Bit mask for new Unicode Tail option 
 * @stable ICU 4.8
 */
#define U_SHAPE_TAIL_TYPE_MASK          0x8000000

#endif
