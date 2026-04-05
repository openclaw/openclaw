// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*   Copyright (C) 2010-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
*******************************************************************************
*   file name:  ucharstriebuilder.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2010nov14
*   created by: Markus W. Scherer
*/

#ifndef __UCHARSTRIEBUILDER_H__
#define __UCHARSTRIEBUILDER_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/stringtriebuilder.h"
#include "unicode/ucharstrie.h"
#include "unicode/unistr.h"

/**
 * \file
 * \brief C++ API: Builder for icu::UCharsTrie
 */

U_NAMESPACE_BEGIN

class UCharsTrieElement;

/**
 * Builder class for UCharsTrie.
 *
 * This class is not intended for public subclassing.
 * @stable ICU 4.8
 */
class U_COMMON_API UCharsTrieBuilder : public StringTrieBuilder {
public:
    /**
     * Constructs an empty builder.
     * @param errorCode Standard ICU error code.
     * @stable ICU 4.8
     */
    UCharsTrieBuilder(UErrorCode &errorCode);

    /**
     * Destructor.
     * @stable ICU 4.8
     */
    virtual ~UCharsTrieBuilder();

    /**
     * Adds a (string, value) pair.
     * The string must be unique.
     * The string contents will be copied; the builder does not keep
     * a reference to the input UnicodeString or its buffer.
     * @param s The input string.
     * @param value The value associated with this string.
     * @param errorCode Standard ICU error code. Its input value must
     *                  pass the U_SUCCESS() test, or else the function returns
     *                  immediately. Check for U_FAILURE() on output or use with
     *                  function chaining. (See User Guide for details.)
     * @return *this
     * @stable ICU 4.8
     */
    UCharsTrieBuilder &add(const UnicodeString &s, int32_t value, UErrorCode &errorCode);

    /**
     * Builds a UCharsTrie for the add()ed data.
     * Once built, no further data can be add()ed until clear() is called.
     *
     * A UCharsTrie cannot be empty. At least one (string, value) pair
     * must have been add()ed.
     *
     * This method passes ownership of the builder's internal result array to the new trie object.
     * Another call to any build() variant will re-serialize the trie.
     * After clear() has been called, a new array will be used as well.
     * @param buildOption Build option, see UStringTrieBuildOption.
     * @param errorCode Standard ICU error code. Its input value must
     *                  pass the U_SUCCESS() test, or else the function returns
     *                  immediately. Check for U_FAILURE() on output or use with
     *                  function chaining. (See User Guide for details.)
     * @return A new UCharsTrie for the add()ed data.
     * @stable ICU 4.8
     */
    UCharsTrie *build(UStringTrieBuildOption buildOption, UErrorCode &errorCode);

    /**
     * Builds a UCharsTrie for the add()ed data and char16_t-serializes it.
     * Once built, no further data can be add()ed until clear() is called.
     *
     * A UCharsTrie cannot be empty. At least one (string, value) pair
     * must have been add()ed.
     *
     * Multiple calls to buildUnicodeString() set the UnicodeStrings to the
     * builder's same char16_t array, without rebuilding.
     * If buildUnicodeString() is called after build(), the trie will be
     * re-serialized into a new array (because build() passes on ownership).
     * If build() is called after buildUnicodeString(), the trie object returned
     * by build() will become the owner of the underlying data for the
     * previously returned UnicodeString.
     * After clear() has been called, a new array will be used as well.
     * @param buildOption Build option, see UStringTrieBuildOption.
     * @param result A UnicodeString which will be set to the char16_t-serialized
     *               UCharsTrie for the add()ed data.
     * @param errorCode Standard ICU error code. Its input value must
     *                  pass the U_SUCCESS() test, or else the function returns
     *                  immediately. Check for U_FAILURE() on output or use with
     *                  function chaining. (See User Guide for details.)
     * @return result
     * @stable ICU 4.8
     */
    UnicodeString &buildUnicodeString(UStringTrieBuildOption buildOption, UnicodeString &result,
                                      UErrorCode &errorCode);

    /**
     * Removes all (string, value) pairs.
     * New data can then be add()ed and a new trie can be built.
     * @return *this
     * @stable ICU 4.8
     */
    UCharsTrieBuilder &clear() {
        strings.remove();
        elementsLength=0;
        ucharsLength=0;
        return *this;
    }

private:
    UCharsTrieBuilder(const UCharsTrieBuilder &other) = delete;  // no copy constructor
    UCharsTrieBuilder &operator=(const UCharsTrieBuilder &other) = delete;  // no assignment operator

    void buildUChars(UStringTrieBuildOption buildOption, UErrorCode &errorCode);

    virtual int32_t getElementStringLength(int32_t i) const override;
    virtual char16_t getElementUnit(int32_t i, int32_t unitIndex) const override;
    virtual int32_t getElementValue(int32_t i) const override;

    virtual int32_t getLimitOfLinearMatch(int32_t first, int32_t last, int32_t unitIndex) const override;

    virtual int32_t countElementUnits(int32_t start, int32_t limit, int32_t unitIndex) const override;
    virtual int32_t skipElementsBySomeUnits(int32_t i, int32_t unitIndex, int32_t count) const override;
    virtual int32_t indexOfElementWithNextUnit(int32_t i, int32_t unitIndex, char16_t unit) const override;

    virtual UBool matchNodesCanHaveValues() const override { return true; }

    virtual int32_t getMaxBranchLinearSubNodeLength() const override { return UCharsTrie::kMaxBranchLinearSubNodeLength; }
    virtual int32_t getMinLinearMatch() const override { return UCharsTrie::kMinLinearMatch; }
    virtual int32_t getMaxLinearMatchLength() const override { return UCharsTrie::kMaxLinearMatchLength; }

    class UCTLinearMatchNode : public LinearMatchNode {
    public:
        UCTLinearMatchNode(const char16_t *units, int32_t len, Node *nextNode);
        virtual bool operator==(const Node &other) const override;
        virtual void write(StringTrieBuilder &builder) override;
    private:
        const char16_t *s;
    };

    virtual Node *createLinearMatchNode(int32_t i, int32_t unitIndex, int32_t length,
                                        Node *nextNode) const override;

    UBool ensureCapacity(int32_t length);
    virtual int32_t write(int32_t unit) override;
    int32_t write(const char16_t *s, int32_t length);
    virtual int32_t writeElementUnits(int32_t i, int32_t unitIndex, int32_t length) override;
    virtual int32_t writeValueAndFinal(int32_t i, UBool isFinal) override;
    virtual int32_t writeValueAndType(UBool hasValue, int32_t value, int32_t node) override;
    virtual int32_t writeDeltaTo(int32_t jumpTarget) override;

    UnicodeString strings;
    UCharsTrieElement *elements;
    int32_t elementsCapacity;
    int32_t elementsLength;

    // char16_t serialization of the trie.
    // Grows from the back: ucharsLength measures from the end of the buffer!
    char16_t *uchars;
    int32_t ucharsCapacity;
    int32_t ucharsLength;
};

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif  // __UCHARSTRIEBUILDER_H__
