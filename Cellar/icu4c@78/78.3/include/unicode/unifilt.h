// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
* Copyright (C) 1999-2010, International Business Machines Corporation and others.
* All Rights Reserved.
**********************************************************************
*   Date        Name        Description
*   11/17/99    aliu        Creation.
**********************************************************************
*/
#ifndef UNIFILT_H
#define UNIFILT_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/unifunct.h"
#include "unicode/unimatch.h"

/**
 * \file 
 * \brief C++ API: Unicode Filter
 */

U_NAMESPACE_BEGIN

/**
 * U_ETHER is used to represent character values for positions outside
 * a range.  For example, transliterator uses this to represent
 * characters outside the range contextStart..contextLimit-1.  This
 * allows explicit matching by rules and UnicodeSets of text outside a
 * defined range.
 * @stable ICU 3.0
 */
#define U_ETHER ((char16_t)0xFFFF)

/**
 *
 * <code>UnicodeFilter</code> defines a protocol for selecting a
 * subset of the full range (U+0000 to U+10FFFF) of Unicode characters.
 * Currently, filters are used in conjunction with classes like
 * {@link Transliterator} to only process selected characters through a
 * transformation.
 *
 * <p>Note: UnicodeFilter currently stubs out two pure virtual methods
 * of its base class, UnicodeMatcher.  These methods are toPattern()
 * and matchesIndexValue().  This is done so that filter classes that
 * are not actually used as matchers -- specifically, those in the
 * UnicodeFilterLogic component, and those in tests -- can continue to
 * work without defining these methods.  As long as a filter is not
 * used in an RBT during real transliteration, these methods will not
 * be called.  However, this breaks the UnicodeMatcher base class
 * protocol, and it is not a correct solution.
 *
 * <p>In the future we may revisit the UnicodeMatcher / UnicodeFilter
 * hierarchy and either redesign it, or simply remove the stubs in
 * UnicodeFilter and force subclasses to implement the full
 * UnicodeMatcher protocol.
 *
 * @see UnicodeFilterLogic
 * @stable ICU 2.0
 */
class U_COMMON_API UnicodeFilter : public UnicodeFunctor, public UnicodeMatcher {

public:
    /**
     * Destructor
     * @stable ICU 2.0
     */
    virtual ~UnicodeFilter();

    /**
     * Clones this object polymorphically.
     * The caller owns the result and should delete it when done.
     * @return clone, or nullptr if an error occurred
     * @stable ICU 2.4
     */
    virtual UnicodeFilter* clone() const override = 0;

    /**
     * Returns <tt>true</tt> for characters that are in the selected
     * subset.  In other words, if a character is <b>to be
     * filtered</b>, then <tt>contains()</tt> returns
     * <b><tt>false</tt></b>.
     * @stable ICU 2.0
     */
    virtual UBool contains(UChar32 c) const = 0;

    /**
     * UnicodeFunctor API.  Cast 'this' to a UnicodeMatcher* pointer
     * and return the pointer.
     * @stable ICU 2.4
     */
    virtual UnicodeMatcher* toMatcher() const override;

    /**
     * Implement UnicodeMatcher API.
     * @stable ICU 2.4
     */
    virtual UMatchDegree matches(const Replaceable& text,
                                 int32_t& offset,
                                 int32_t limit,
                                 UBool incremental) override;

    /**
     * UnicodeFunctor API.  Nothing to do.
     * @stable ICU 2.4
     */
    virtual void setData(const TransliterationRuleData*) override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 2.2
     */
    static UClassID U_EXPORT2 getStaticClassID();

protected:

    /*
     * Since this class has pure virtual functions,
     * a constructor can't be used.
     * @stable ICU 2.0
     */
/*    UnicodeFilter();*/
};

/*inline UnicodeFilter::UnicodeFilter() {}*/

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
