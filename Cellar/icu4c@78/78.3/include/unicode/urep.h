// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*   Copyright (C) 1997-2010, International Business Machines
*   Corporation and others.  All Rights Reserved.
******************************************************************************
*   Date        Name        Description
*   06/23/00    aliu        Creation.
******************************************************************************
*/

#ifndef __UREP_H
#define __UREP_H

#include "unicode/utypes.h"

U_CDECL_BEGIN

/********************************************************************
 * General Notes
 ********************************************************************
 * TODO
 * Add usage scenario
 * Add test code
 * Talk about pinning
 * Talk about "can truncate result if out of memory"
 */

/********************************************************************
 * Data Structures
 ********************************************************************/
/**
 * \file
 * \brief C API: Callbacks for UReplaceable
 */
/**
 * An opaque replaceable text object.  This will be manipulated only
 * through the caller-supplied UReplaceableFunctor struct.  Related
 * to the C++ class Replaceable.
 * This is currently only used in the Transliterator C API, see utrans.h .
 * @stable ICU 2.0
 */
typedef void* UReplaceable;

/**
 * A set of function pointers that transliterators use to manipulate a
 * UReplaceable.  The caller should supply the required functions to
 * manipulate their text appropriately.  Related to the C++ class
 * Replaceable.
 * @stable ICU 2.0
 */
typedef struct UReplaceableCallbacks {

    /**
     * Function pointer that returns the number of UChar code units in
     * this text.
     *
     * @param rep A pointer to "this" UReplaceable object.
     * @return The length of the text.
     * @stable ICU 2.0
     */
    int32_t (*length)(const UReplaceable* rep);

    /**
     * Function pointer that returns a UChar code units at the given
     * offset into this text; 0 <= offset < n, where n is the value
     * returned by (*length)(rep).  See unistr.h for a description of
     * charAt() vs. char32At().
     *
     * @param rep A pointer to "this" UReplaceable object.
     * @param offset The index at which to fetch the UChar (code unit).
     * @return The UChar (code unit) at offset, or U+FFFF if the offset is out of bounds.
     * @stable ICU 2.0
     */
    UChar   (*charAt)(const UReplaceable* rep,
                      int32_t offset);

    /**
     * Function pointer that returns a UChar32 code point at the given
     * offset into this text.  See unistr.h for a description of
     * charAt() vs. char32At().
     *
     * @param rep A pointer to "this" UReplaceable object.
     * @param offset The index at which to fetch the UChar32 (code point).
     * @return The UChar32 (code point) at offset, or U+FFFF if the offset is out of bounds.
     * @stable ICU 2.0
     */
    UChar32 (*char32At)(const UReplaceable* rep,
                        int32_t offset);
    
    /**
     * Function pointer that replaces text between start and limit in
     * this text with the given text.  Attributes (out of band info)
     * should be retained.
     *
     * @param rep A pointer to "this" UReplaceable object.
     * @param start the starting index of the text to be replaced,
     * inclusive.
     * @param limit the ending index of the text to be replaced,
     * exclusive.
     * @param text the new text to replace the UChars from
     * start..limit-1.
     * @param textLength the number of UChars at text, or -1 if text
     * is null-terminated.
     * @stable ICU 2.0
     */
    void    (*replace)(UReplaceable* rep,
                       int32_t start,
                       int32_t limit,
                       const UChar* text,
                       int32_t textLength);
    
    /**
     * Function pointer that copies the characters in the range
     * [<tt>start</tt>, <tt>limit</tt>) into the array <tt>dst</tt>.
     *
     * @param rep A pointer to "this" UReplaceable object.
     * @param start offset of first character which will be copied
     * into the array
     * @param limit offset immediately following the last character to
     * be copied
     * @param dst array in which to copy characters.  The length of
     * <tt>dst</tt> must be at least <tt>(limit - start)</tt>.
     * @stable ICU 2.1
     */
    void    (*extract)(UReplaceable* rep,
                       int32_t start,
                       int32_t limit,
                       UChar* dst);

    /**
     * Function pointer that copies text between start and limit in
     * this text to another index in the text.  Attributes (out of
     * band info) should be retained.  After this call, there will be
     * (at least) two copies of the characters originally located at
     * start..limit-1.
     *
     * @param rep A pointer to "this" UReplaceable object.
     * @param start the starting index of the text to be copied,
     * inclusive.
     * @param limit the ending index of the text to be copied,
     * exclusive.
     * @param dest the index at which the copy of the UChars should be
     * inserted.
     * @stable ICU 2.0
     */
    void    (*copy)(UReplaceable* rep,
                    int32_t start,
                    int32_t limit,
                    int32_t dest);    

} UReplaceableCallbacks;

U_CDECL_END

#endif
