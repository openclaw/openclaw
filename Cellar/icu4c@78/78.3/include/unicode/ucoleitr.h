// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*   Copyright (C) 2001-2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
*******************************************************************************
*
* File ucoleitr.h
*
* Modification History:
*
* Date        Name        Description
* 02/15/2001  synwee      Modified all methods to process its own function 
*                         instead of calling the equivalent c++ api (coleitr.h)
*******************************************************************************/

#ifndef UCOLEITR_H
#define UCOLEITR_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_COLLATION

/**  
 * This indicates an error has occurred during processing or if no more CEs is 
 * to be returned.
 * @stable ICU 2.0
 */
#define UCOL_NULLORDER        ((int32_t)0xFFFFFFFF)

#include "unicode/ucol.h"

/** 
 * The UCollationElements struct.
 * For usage in C programs.
 * @stable ICU 2.0
 */
typedef struct UCollationElements UCollationElements;

/**
 * \file
 * \brief C API: UCollationElements
 *
 * The UCollationElements API is used as an iterator to walk through each 
 * character of an international string. Use the iterator to return the
 * ordering priority of the positioned character. The ordering priority of a 
 * character, which we refer to as a key, defines how a character is collated 
 * in the given collation object.
 * For example, consider the following in Slovak and in traditional Spanish collation:
 * <pre>
 * .       "ca" -> the first key is key('c') and second key is key('a').
 * .       "cha" -> the first key is key('ch') and second key is key('a').
 * </pre>
 * And in German phonebook collation,
 * <pre>
 * .       "<ae ligature>b"-> the first key is key('a'), the second key is key('e'), and
 * .       the third key is key('b').
 * </pre>
 * <p>Example of the iterator usage: (without error checking)
 * <pre>
 * .  void CollationElementIterator_Example()
 * .  {
 * .      UChar *s;
 * .      t_int32 order, primaryOrder;
 * .      UCollationElements *c;
 * .      UCollatorOld *coll;
 * .      UErrorCode success = U_ZERO_ERROR;
 * .      str=(UChar*)malloc(sizeof(UChar) * (strlen("This is a test")+1) );
 * .      u_uastrcpy(str, "This is a test");
 * .      coll = ucol_open(NULL, &success);
 * .      c = ucol_openElements(coll, str, u_strlen(str), &status);
 * .      order = ucol_next(c, &success);
 * .      ucol_reset(c);
 * .      order = ucol_prev(c, &success);
 * .      free(str);
 * .      ucol_close(coll);
 * .      ucol_closeElements(c);
 * .  }
 * </pre>
 * <p>
 * ucol_next() returns the collation order of the next.
 * ucol_prev() returns the collation order of the previous character.
 * The Collation Element Iterator moves only in one direction between calls to
 * ucol_reset. That is, ucol_next() and ucol_prev can not be inter-used. 
 * Whenever ucol_prev is to be called after ucol_next() or vice versa, 
 * ucol_reset has to be called first to reset the status, shifting pointers to 
 * either the end or the start of the string. Hence at the next call of 
 * ucol_prev or ucol_next, the first or last collation order will be returned. 
 * If a change of direction is done without a ucol_reset, the result is 
 * undefined.
 * The result of a forward iterate (ucol_next) and reversed result of the  
 * backward iterate (ucol_prev) on the same string are equivalent, if 
 * collation orders with the value 0 are ignored.
 * Character based on the comparison level of the collator.  A collation order 
 * consists of primary order, secondary order and tertiary order.  The data 
 * type of the collation order is <strong>int32_t</strong>. 
 *
 * @see UCollator
 */

/**
 * Open the collation elements for a string.
 *
 * The UCollationElements retains a pointer to the supplied text.
 * The caller must not modify or delete the text while the UCollationElements
 * object is used to iterate over this text.
 *
 * @param coll The collator containing the desired collation rules.
 * @param text The text to iterate over.
 * @param textLength The number of characters in text, or -1 if null-terminated
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return a struct containing collation element information
 * @stable ICU 2.0
 */
U_CAPI UCollationElements* U_EXPORT2 
ucol_openElements(const UCollator  *coll,
                  const UChar      *text,
                        int32_t    textLength,
                        UErrorCode *status);

/**
 * get a hash code for a key... Not very useful!
 * @param key    the given key.
 * @param length the size of the key array.
 * @return       the hash code.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_keyHashCode(const uint8_t* key, int32_t length);

/**
 * Close a UCollationElements.
 * Once closed, a UCollationElements may no longer be used.
 * @param elems The UCollationElements to close.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucol_closeElements(UCollationElements *elems);

/**
 * Reset the collation elements to their initial state.
 * This will move the 'cursor' to the beginning of the text.
 * Property settings for collation will be reset to the current status.
 * @param elems The UCollationElements to reset.
 * @see ucol_next
 * @see ucol_previous
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucol_reset(UCollationElements *elems);

/**
 * Get the ordering priority of the next collation element in the text.
 * A single character may contain more than one collation element.
 * @param elems The UCollationElements containing the text.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return The next collation elements ordering, otherwise returns UCOL_NULLORDER 
 *         if an error has occurred or if the end of string has been reached
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_next(UCollationElements *elems, UErrorCode *status);

/**
 * Get the ordering priority of the previous collation element in the text.
 * A single character may contain more than one collation element.
 * Note that internally a stack is used to store buffered collation elements. 
 * @param elems The UCollationElements containing the text.
 * @param status A pointer to a UErrorCode to receive any errors. Notably 
 *               a U_BUFFER_OVERFLOW_ERROR is returned if the internal stack
 *               buffer has been exhausted.
 * @return The previous collation elements ordering, otherwise returns 
 *         UCOL_NULLORDER if an error has occurred or if the start of string has 
 *         been reached.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_previous(UCollationElements *elems, UErrorCode *status);

/**
 * Get the maximum length of any expansion sequences that end with the 
 * specified comparison order.
 * This is useful for .... ?
 * @param elems The UCollationElements containing the text.
 * @param order A collation order returned by previous or next.
 * @return maximum size of the expansion sequences ending with the collation 
 *         element or 1 if collation element does not occur at the end of any 
 *         expansion sequence
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_getMaxExpansion(const UCollationElements *elems, int32_t order);

/**
 * Set the text containing the collation elements.
 * Property settings for collation will remain the same.
 * In order to reset the iterator to the current collation property settings,
 * the API reset() has to be called.
 *
 * The UCollationElements retains a pointer to the supplied text.
 * The caller must not modify or delete the text while the UCollationElements
 * object is used to iterate over this text.
 *
 * @param elems The UCollationElements to set.
 * @param text The source text containing the collation elements.
 * @param textLength The length of text, or -1 if null-terminated.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @see ucol_getText
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucol_setText(      UCollationElements *elems,
             const UChar              *text,
                   int32_t            textLength,
                   UErrorCode         *status);

/**
 * Get the offset of the current source character.
 * This is an offset into the text of the character containing the current
 * collation elements.
 * @param elems The UCollationElements to query.
 * @return The offset of the current source character.
 * @see ucol_setOffset
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_getOffset(const UCollationElements *elems);

/**
 * Set the offset of the current source character.
 * This is an offset into the text of the character to be processed.
 * Property settings for collation will remain the same.
 * In order to reset the iterator to the current collation property settings,
 * the API reset() has to be called.
 * @param elems The UCollationElements to set.
 * @param offset The desired character offset.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @see ucol_getOffset
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucol_setOffset(UCollationElements *elems,
               int32_t             offset,
               UErrorCode         *status);

/**
* Get the primary order of a collation order.
* @param order the collation order
* @return the primary order of a collation order.
* @stable ICU 2.6
*/
U_CAPI int32_t U_EXPORT2
ucol_primaryOrder (int32_t order); 

/**
* Get the secondary order of a collation order.
* @param order the collation order
* @return the secondary order of a collation order.
* @stable ICU 2.6
*/
U_CAPI int32_t U_EXPORT2
ucol_secondaryOrder (int32_t order); 

/**
* Get the tertiary order of a collation order.
* @param order the collation order
* @return the tertiary order of a collation order.
* @stable ICU 2.6
*/
U_CAPI int32_t U_EXPORT2
ucol_tertiaryOrder (int32_t order); 

#endif /* #if !UCONFIG_NO_COLLATION */

#endif
