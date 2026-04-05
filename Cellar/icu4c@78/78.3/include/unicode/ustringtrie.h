// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*   Copyright (C) 2010-2012, International Business Machines
*   Corporation and others.  All Rights Reserved.
*******************************************************************************
*   file name:  udicttrie.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2010dec17
*   created by: Markus W. Scherer
*/

#ifndef __USTRINGTRIE_H__
#define __USTRINGTRIE_H__

/**
 * \file
 * \brief C API: Helper definitions for dictionary trie APIs.
 */

#include "unicode/utypes.h"


/**
 * Return values for BytesTrie::next(), UCharsTrie::next() and similar methods.
 * @see USTRINGTRIE_MATCHES
 * @see USTRINGTRIE_HAS_VALUE
 * @see USTRINGTRIE_HAS_NEXT
 * @stable ICU 4.8
 */
enum UStringTrieResult {
    /**
     * The input unit(s) did not continue a matching string.
     * Once current()/next() return USTRINGTRIE_NO_MATCH,
     * all further calls to current()/next() will also return USTRINGTRIE_NO_MATCH,
     * until the trie is reset to its original state or to a saved state.
     * @stable ICU 4.8
     */
    USTRINGTRIE_NO_MATCH,
    /**
     * The input unit(s) continued a matching string
     * but there is no value for the string so far.
     * (It is a prefix of a longer string.)
     * @stable ICU 4.8
     */
    USTRINGTRIE_NO_VALUE,
    /**
     * The input unit(s) continued a matching string
     * and there is a value for the string so far.
     * This value will be returned by getValue().
     * No further input byte/unit can continue a matching string.
     * @stable ICU 4.8
     */
    USTRINGTRIE_FINAL_VALUE,
    /**
     * The input unit(s) continued a matching string
     * and there is a value for the string so far.
     * This value will be returned by getValue().
     * Another input byte/unit can continue a matching string.
     * @stable ICU 4.8
     */
    USTRINGTRIE_INTERMEDIATE_VALUE
};

/**
 * Same as (result!=USTRINGTRIE_NO_MATCH).
 * @param result A result from BytesTrie::first(), UCharsTrie::next() etc.
 * @return true if the input bytes/units so far are part of a matching string/byte sequence.
 * @stable ICU 4.8
 */
#define USTRINGTRIE_MATCHES(result) ((result)!=USTRINGTRIE_NO_MATCH)

/**
 * Equivalent to (result==USTRINGTRIE_INTERMEDIATE_VALUE || result==USTRINGTRIE_FINAL_VALUE) but
 * this macro evaluates result exactly once.
 * @param result A result from BytesTrie::first(), UCharsTrie::next() etc.
 * @return true if there is a value for the input bytes/units so far.
 * @see BytesTrie::getValue
 * @see UCharsTrie::getValue
 * @stable ICU 4.8
 */
#define USTRINGTRIE_HAS_VALUE(result) ((result)>=USTRINGTRIE_FINAL_VALUE)

/**
 * Equivalent to (result==USTRINGTRIE_NO_VALUE || result==USTRINGTRIE_INTERMEDIATE_VALUE) but
 * this macro evaluates result exactly once.
 * @param result A result from BytesTrie::first(), UCharsTrie::next() etc.
 * @return true if another input byte/unit can continue a matching string.
 * @stable ICU 4.8
 */
#define USTRINGTRIE_HAS_NEXT(result) ((result)&1)

#endif  /* __USTRINGTRIE_H__ */
