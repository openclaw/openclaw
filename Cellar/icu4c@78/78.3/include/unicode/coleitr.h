// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 ******************************************************************************
 *   Copyright (C) 1997-2014, International Business Machines
 *   Corporation and others.  All Rights Reserved.
 ******************************************************************************
 */

/**
 * \file 
 * \brief C++ API: Collation Element Iterator.
 */

/**
* File coleitr.h
*
* Created by: Helena Shih
*
* Modification History:
*
*  Date       Name        Description
*
*  8/18/97    helena      Added internal API documentation.
* 08/03/98    erm         Synched with 1.2 version CollationElementIterator.java
* 12/10/99    aliu        Ported Thai collation support from Java.
* 01/25/01    swquek      Modified into a C++ wrapper calling C APIs (ucoliter.h)
* 02/19/01    swquek      Removed CollationElementsIterator() since it is 
*                         private constructor and no calls are made to it
* 2012-2014   markus      Rewritten in C++ again.
*/

#ifndef COLEITR_H
#define COLEITR_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_COLLATION

#include "unicode/unistr.h"
#include "unicode/uobject.h"

struct UCollationElements;
struct UHashtable;

U_NAMESPACE_BEGIN

struct CollationData;

class CharacterIterator;
class CollationIterator;
class RuleBasedCollator;
class UCollationPCE;
class UVector32;

/**
* The CollationElementIterator class is used as an iterator to walk through     
* each character of an international string. Use the iterator to return the
* ordering priority of the positioned character. The ordering priority of a 
* character, which we refer to as a key, defines how a character is collated in 
* the given collation object.
* For example, consider the following in Slovak and in traditional Spanish collation:
* <pre>
*        "ca" -> the first key is key('c') and second key is key('a').
*        "cha" -> the first key is key('ch') and second key is key('a').</pre>
* And in German phonebook collation,
* <pre> \htmlonly       "&#x00E6;b"-> the first key is key('a'), the second key is key('e'), and
*        the third key is key('b'). \endhtmlonly </pre>
* The key of a character, is an integer composed of primary order(short),
* secondary order(char), and tertiary order(char). Java strictly defines the 
* size and signedness of its primitive data types. Therefore, the static
* functions primaryOrder(), secondaryOrder(), and tertiaryOrder() return 
* int32_t to ensure the correctness of the key value.
* <p>Example of the iterator usage: (without error checking)
* <pre>
* \code
*   void CollationElementIterator_Example()
*   {
*       UnicodeString str = "This is a test";
*       UErrorCode success = U_ZERO_ERROR;
*       RuleBasedCollator* rbc =
*           (RuleBasedCollator*) RuleBasedCollator::createInstance(success);
*       CollationElementIterator* c =
*           rbc->createCollationElementIterator( str );
*       int32_t order = c->next(success);
*       c->reset();
*       order = c->previous(success);
*       delete c;
*       delete rbc;
*   }
* \endcode
* </pre>
* <p>
* The method next() returns the collation order of the next character based on
* the comparison level of the collator. The method previous() returns the
* collation order of the previous character based on the comparison level of
* the collator. The Collation Element Iterator moves only in one direction
* between calls to reset(), setOffset(), or setText(). That is, next() 
* and previous() can not be inter-used. Whenever previous() is to be called after 
* next() or vice versa, reset(), setOffset() or setText() has to be called first
* to reset the status, shifting pointers to either the end or the start of
* the string (reset() or setText()), or the specified position (setOffset()).
* Hence at the next call of next() or previous(), the first or last collation order,
* or collation order at the specified position will be returned. If a change of
* direction is done without one of these calls, the result is undefined.
* <p>
* The result of a forward iterate (next()) and reversed result of the backward
* iterate (previous()) on the same string are equivalent, if collation orders
* with the value 0 are ignored.
* Character based on the comparison level of the collator.  A collation order 
* consists of primary order, secondary order and tertiary order.  The data 
* type of the collation order is <strong>int32_t</strong>. 
*
* Note, CollationElementIterator should not be subclassed.
* @see     Collator
* @see     RuleBasedCollator
* @version 1.8 Jan 16 2001
*/
class U_I18N_API CollationElementIterator final : public UObject {
public: 

    // CollationElementIterator public data member ------------------------------

    enum {
        /**
         * NULLORDER indicates that an error has occurred while processing
         * @stable ICU 2.0
         */
        NULLORDER = static_cast<int32_t>(0xffffffff)
    };

    // CollationElementIterator public constructor/destructor -------------------

    /**
    * Copy constructor.
    *
    * @param other    the object to be copied from
    * @stable ICU 2.0
    */
    CollationElementIterator(const CollationElementIterator& other);

    /** 
    * Destructor
    * @stable ICU 2.0
    */
    virtual ~CollationElementIterator();

    // CollationElementIterator public methods ----------------------------------

    /**
    * Returns true if "other" is the same as "this"
    *
    * @param other    the object to be compared
    * @return         true if "other" is the same as "this"
    * @stable ICU 2.0
    */
    bool operator==(const CollationElementIterator& other) const;

    /**
    * Returns true if "other" is not the same as "this".
    *
    * @param other    the object to be compared
    * @return         true if "other" is not the same as "this"
    * @stable ICU 2.0
    */
    bool operator!=(const CollationElementIterator& other) const;

    /**
    * Resets the cursor to the beginning of the string.
    * @stable ICU 2.0
    */
    void reset();

    /**
    * Gets the ordering priority of the next character in the string.
    * @param status the error code status.
    * @return the next character's ordering. otherwise returns NULLORDER if an 
    *         error has occurred or if the end of string has been reached
    * @stable ICU 2.0
    */
    int32_t next(UErrorCode& status);

    /**
    * Get the ordering priority of the previous collation element in the string.
    * @param status the error code status.
    * @return the previous element's ordering. otherwise returns NULLORDER if an 
    *         error has occurred or if the start of string has been reached
    * @stable ICU 2.0
    */
    int32_t previous(UErrorCode& status);

    /**
    * Gets the primary order of a collation order.
    * @param order the collation order
    * @return the primary order of a collation order.
    * @stable ICU 2.0
    */
    static inline int32_t primaryOrder(int32_t order);

    /**
    * Gets the secondary order of a collation order.
    * @param order the collation order
    * @return the secondary order of a collation order.
    * @stable ICU 2.0
    */
    static inline int32_t secondaryOrder(int32_t order);

    /**
    * Gets the tertiary order of a collation order.
    * @param order the collation order
    * @return the tertiary order of a collation order.
    * @stable ICU 2.0
    */
    static inline int32_t tertiaryOrder(int32_t order);

    /**
    * Return the maximum length of any expansion sequences that end with the 
    * specified comparison order.
    * @param order a collation order returned by previous or next.
    * @return maximum size of the expansion sequences ending with the collation 
    *         element or 1 if collation element does not occur at the end of any 
    *         expansion sequence
    * @stable ICU 2.0
    */
    int32_t getMaxExpansion(int32_t order) const;

    /**
    * Gets the comparison order in the desired strength. Ignore the other
    * differences.
    * @param order The order value
    * @stable ICU 2.0
    */
    int32_t strengthOrder(int32_t order) const;

    /**
    * Sets the source string.
    * @param str the source string.
    * @param status the error code status.
    * @stable ICU 2.0
    */
    void setText(const UnicodeString& str, UErrorCode& status);

    /**
    * Sets the source string.
    * @param str the source character iterator.
    * @param status the error code status.
    * @stable ICU 2.0
    */
    void setText(CharacterIterator& str, UErrorCode& status);

    /**
    * Checks if a comparison order is ignorable.
    * @param order the collation order.
    * @return true if a character is ignorable, false otherwise.
    * @stable ICU 2.0
    */
    static inline UBool isIgnorable(int32_t order);

    /**
    * Gets the offset of the currently processed character in the source string.
    * @return the offset of the character.
    * @stable ICU 2.0
    */
    int32_t getOffset() const;

    /**
    * Sets the offset of the currently processed character in the source string.
    * @param newOffset the new offset.
    * @param status the error code status.
    * @return the offset of the character.
    * @stable ICU 2.0
    */
    void setOffset(int32_t newOffset, UErrorCode& status);

    /**
    * ICU "poor man's RTTI", returns a UClassID for the actual class.
    *
    * @stable ICU 2.2
    */
    virtual UClassID getDynamicClassID() const override;

    /**
    * ICU "poor man's RTTI", returns a UClassID for this class.
    *
    * @stable ICU 2.2
    */
    static UClassID U_EXPORT2 getStaticClassID();

#ifndef U_HIDE_INTERNAL_API
    /** @internal */
    static inline CollationElementIterator *fromUCollationElements(UCollationElements *uc) {
        return reinterpret_cast<CollationElementIterator *>(uc);
    }
    /** @internal */
    static inline const CollationElementIterator *fromUCollationElements(const UCollationElements *uc) {
        return reinterpret_cast<const CollationElementIterator *>(uc);
    }
    /** @internal */
    inline UCollationElements *toUCollationElements() {
        return reinterpret_cast<UCollationElements *>(this);
    }
    /** @internal */
    inline const UCollationElements *toUCollationElements() const {
        return reinterpret_cast<const UCollationElements *>(this);
    }
#endif  // U_HIDE_INTERNAL_API

private:
    friend class RuleBasedCollator;
    friend class UCollationPCE;

    /**
    * CollationElementIterator constructor. This takes the source string and the 
    * collation object. The cursor will walk thru the source string based on the 
    * predefined collation rules. If the source string is empty, NULLORDER will 
    * be returned on the calls to next().
    * @param sourceText    the source string.
    * @param order         the collation object.
    * @param status        the error code status.
    */
    CollationElementIterator(const UnicodeString& sourceText,
        const RuleBasedCollator* order, UErrorCode& status);
    // Note: The constructors should take settings & tailoring, not a collator,
    // to avoid circular dependencies.
    // However, for operator==() we would need to be able to compare tailoring data for equality
    // without making CollationData or CollationTailoring depend on TailoredSet.
    // (See the implementation of RuleBasedCollator::operator==().)
    // That might require creating an intermediate class that would be used
    // by both CollationElementIterator and RuleBasedCollator
    // but only contain the part of RBC== related to data and rules.

    /**
    * CollationElementIterator constructor. This takes the source string and the 
    * collation object.  The cursor will walk thru the source string based on the 
    * predefined collation rules.  If the source string is empty, NULLORDER will 
    * be returned on the calls to next().
    * @param sourceText    the source string.
    * @param order         the collation object.
    * @param status        the error code status.
    */
    CollationElementIterator(const CharacterIterator& sourceText,
        const RuleBasedCollator* order, UErrorCode& status);

    /**
    * Assignment operator
    *
    * @param other    the object to be copied
    */
    const CollationElementIterator&
        operator=(const CollationElementIterator& other);

    CollationElementIterator() = delete; // default constructor not implemented

    /** Normalizes dir_=1 (just after setOffset()) to dir_=0 (just after reset()). */
    inline int8_t normalizeDir() const { return dir_ == 1 ? 0 : dir_; }

    static UHashtable *computeMaxExpansions(const CollationData *data, UErrorCode &errorCode);

    static int32_t getMaxExpansion(const UHashtable *maxExpansions, int32_t order);

    // CollationElementIterator private data members ----------------------------

    CollationIterator *iter_;  // owned
    const RuleBasedCollator *rbc_;  // aliased
    uint32_t otherHalf_;
    /**
     * <0: backwards; 0: just after reset() (previous() begins from end);
     * 1: just after setOffset(); >1: forward
     */
    int8_t dir_;
    /**
     * Stores offsets from expansions and from unsafe-backwards iteration,
     * so that getOffset() returns intermediate offsets for the CEs
     * that are consistent with forward iteration.
     */
    UVector32 *offsets_;

    UnicodeString string_;
};

// CollationElementIterator inline method definitions --------------------------

inline int32_t CollationElementIterator::primaryOrder(int32_t order)
{
    return (order >> 16) & 0xffff;
}

inline int32_t CollationElementIterator::secondaryOrder(int32_t order)
{
    return (order >> 8) & 0xff;
}

inline int32_t CollationElementIterator::tertiaryOrder(int32_t order)
{
    return order & 0xff;
}

inline UBool CollationElementIterator::isIgnorable(int32_t order)
{
    return (order & 0xffff0000) == 0;
}

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_COLLATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
