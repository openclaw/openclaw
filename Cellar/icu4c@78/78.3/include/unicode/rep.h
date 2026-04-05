// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**************************************************************************
* Copyright (C) 1999-2012, International Business Machines Corporation and
* others. All Rights Reserved.
**************************************************************************
*   Date        Name        Description
*   11/17/99    aliu        Creation.  Ported from java.  Modified to
*                           match current UnicodeString API.  Forced
*                           to use name "handleReplaceBetween" because
*                           of existing methods in UnicodeString.
**************************************************************************
*/

#ifndef REP_H
#define REP_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/uobject.h"

/**
 * \file 
 * \brief C++ API: Replaceable String
 */
 
U_NAMESPACE_BEGIN

class UnicodeString;

/**
 * <code>Replaceable</code> is an abstract base class representing a
 * string of characters that supports the replacement of a range of
 * itself with a new string of characters.  It is used by APIs that
 * change a piece of text while retaining metadata.  Metadata is data
 * other than the Unicode characters returned by char32At().  One
 * example of metadata is style attributes; another is an edit
 * history, marking each character with an author and revision number.
 *
 * <p>An implicit aspect of the <code>Replaceable</code> API is that
 * during a replace operation, new characters take on the metadata of
 * the old characters.  For example, if the string "the <b>bold</b>
 * font" has range (4, 8) replaced with "strong", then it becomes "the
 * <b>strong</b> font".
 *
 * <p><code>Replaceable</code> specifies ranges using a start
 * offset and a limit offset.  The range of characters thus specified
 * includes the characters at offset start..limit-1.  That is, the
 * start offset is inclusive, and the limit offset is exclusive.
 *
 * <p><code>Replaceable</code> also includes API to access characters
 * in the string: <code>length()</code>, <code>charAt()</code>,
 * <code>char32At()</code>, and <code>extractBetween()</code>.
 *
 * <p>For a subclass to support metadata, typical behavior of
 * <code>replace()</code> is the following:
 * <ul>
 *   <li>Set the metadata of the new text to the metadata of the first
 *   character replaced</li>
 *   <li>If no characters are replaced, use the metadata of the
 *   previous character</li>
 *   <li>If there is no previous character (i.e. start == 0), use the
 *   following character</li>
 *   <li>If there is no following character (i.e. the replaceable was
 *   empty), use default metadata.<br>
 *   <li>If the code point U+FFFF is seen, it should be interpreted as
 *   a special marker having no metadata<li>
 *   </li>
 * </ul>
 * If this is not the behavior, the subclass should document any differences.
 * @author Alan Liu
 * @stable ICU 2.0
 */
class U_COMMON_API Replaceable : public UObject {

public:
    /**
     * Destructor.
     * @stable ICU 2.0
     */
    virtual ~Replaceable();

    /**
     * Returns the number of 16-bit code units in the text.
     * @return number of 16-bit code units in text
     * @stable ICU 1.8
     */ 
    inline int32_t length() const;

    /**
     * Returns the 16-bit code unit at the given offset into the text.
     * @param offset an integer between 0 and <code>length()</code>-1
     * inclusive
     * @return 16-bit code unit of text at given offset
     * @stable ICU 1.8
     */
    inline char16_t charAt(int32_t offset) const;

    /**
     * Returns the 32-bit code point at the given 16-bit offset into
     * the text.  This assumes the text is stored as 16-bit code units
     * with surrogate pairs intermixed.  If the offset of a leading or
     * trailing code unit of a surrogate pair is given, return the
     * code point of the surrogate pair.
     *
     * @param offset an integer between 0 and <code>length()</code>-1
     * inclusive
     * @return 32-bit code point of text at given offset
     * @stable ICU 1.8
     */
    inline UChar32 char32At(int32_t offset) const;

    /**
     * Copies characters in the range [<tt>start</tt>, <tt>limit</tt>) 
     * into the UnicodeString <tt>target</tt>.
     * @param start offset of first character which will be copied
     * @param limit offset immediately following the last character to
     * be copied
     * @param target UnicodeString into which to copy characters.
     * @return A reference to <TT>target</TT>
     * @stable ICU 2.1
     */
    virtual void extractBetween(int32_t start,
                                int32_t limit,
                                UnicodeString& target) const = 0;

    /**
     * Replaces a substring of this object with the given text.  If the
     * characters being replaced have metadata, the new characters
     * that replace them should be given the same metadata.
     *
     * <p>Subclasses must ensure that if the text between start and
     * limit is equal to the replacement text, that replace has no
     * effect. That is, any metadata
     * should be unaffected. In addition, subclasses are encouraged to
     * check for initial and trailing identical characters, and make a
     * smaller replacement if possible. This will preserve as much
     * metadata as possible.
     * @param start the beginning index, inclusive; <code>0 <= start
     * <= limit</code>.
     * @param limit the ending index, exclusive; <code>start <= limit
     * <= length()</code>.
     * @param text the text to replace characters <code>start</code>
     * to <code>limit - 1</code> 
     * @stable ICU 2.0
     */
    virtual void handleReplaceBetween(int32_t start,
                                      int32_t limit,
                                      const UnicodeString& text) = 0;
    // Note: All other methods in this class take the names of
    // existing UnicodeString methods.  This method is the exception.
    // It is named differently because all replace methods of
    // UnicodeString return a UnicodeString&.  The 'between' is
    // required in order to conform to the UnicodeString naming
    // convention; API taking start/length are named <operation>, and
    // those taking start/limit are named <operationBetween>.  The
    // 'handle' is added because 'replaceBetween' and
    // 'doReplaceBetween' are already taken.

    /**
     * Copies a substring of this object, retaining metadata.
     * This method is used to duplicate or reorder substrings.
     * The destination index must not overlap the source range.
     * 
     * @param start the beginning index, inclusive; <code>0 <= start <=
     * limit</code>.
     * @param limit the ending index, exclusive; <code>start <= limit <=
     * length()</code>.
     * @param dest the destination index.  The characters from
     * <code>start..limit-1</code> will be copied to <code>dest</code>.
     * Implementations of this method may assume that <code>dest <= start ||
     * dest >= limit</code>.
     * @stable ICU 2.0
     */
    virtual void copy(int32_t start, int32_t limit, int32_t dest) = 0;

    /**
     * Returns true if this object contains metadata.  If a
     * Replaceable object has metadata, calls to the Replaceable API
     * must be made so as to preserve metadata.  If it does not, calls
     * to the Replaceable API may be optimized to improve performance.
     * The default implementation returns true.
     * @return true if this object contains metadata
     * @stable ICU 2.2
     */
    virtual UBool hasMetaData() const;

    /**
     * Clone this object, an instance of a subclass of Replaceable.
     * Clones can be used concurrently in multiple threads.
     * If a subclass does not implement clone(), or if an error occurs,
     * then nullptr is returned.
     * The caller must delete the clone.
     *
     * @return a clone of this object
     *
     * @see getDynamicClassID
     * @stable ICU 2.6
     */
    virtual Replaceable *clone() const;

protected:

    /**
     * Default constructor.
     * @stable ICU 2.4
     */
    inline Replaceable();

    /*
     * Assignment operator not declared. The compiler will provide one
     * which does nothing since this class does not contain any data members.
     * API/code coverage may show the assignment operator as present and
     * untested - ignore.
     * Subclasses need this assignment operator if they use compiler-provided
     * assignment operators of their own. An alternative to not declaring one
     * here would be to declare and empty-implement a protected or public one.
    Replaceable &Replaceable::operator=(const Replaceable &);
     */

    /**
     * Virtual version of length().
     * @stable ICU 2.4
     */ 
    virtual int32_t getLength() const = 0;

    /**
     * Virtual version of charAt().
     * @stable ICU 2.4
     */
    virtual char16_t getCharAt(int32_t offset) const = 0;

    /**
     * Virtual version of char32At().
     * @stable ICU 2.4
     */
    virtual UChar32 getChar32At(int32_t offset) const = 0;
};

inline Replaceable::Replaceable() {}

inline int32_t
Replaceable::length() const {
    return getLength();
}

inline char16_t
Replaceable::charAt(int32_t offset) const {
    return getCharAt(offset);
}

inline UChar32
Replaceable::char32At(int32_t offset) const {
    return getChar32At(offset);
}

// There is no rep.cpp, see unistr.cpp for Replaceable function implementations.

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
