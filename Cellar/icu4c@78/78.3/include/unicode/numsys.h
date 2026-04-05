// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2010-2014, International Business Machines Corporation and
* others. All Rights Reserved.
*******************************************************************************
*
*
* File NUMSYS.H
*
* Modification History:*
*   Date        Name        Description
*
********************************************************************************
*/

#ifndef NUMSYS
#define NUMSYS

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: NumberingSystem object
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/format.h"
#include "unicode/uobject.h"

U_NAMESPACE_BEGIN

// can't be #ifndef U_HIDE_INTERNAL_API; needed for char[] field size
/**
 * Size of a numbering system name.
 * @internal
 */
constexpr const size_t kInternalNumSysNameCapacity = 8;

/**
 * Defines numbering systems. A numbering system describes the scheme by which 
 * numbers are to be presented to the end user.  In its simplest form, a numbering
 * system describes the set of digit characters that are to be used to display
 * numbers, such as Western digits, Thai digits, Arabic-Indic digits, etc., in a
 * positional numbering system with a specified radix (typically 10).
 * More complicated numbering systems are algorithmic in nature, and require use
 * of an RBNF formatter ( rule based number formatter ), in order to calculate
 * the characters to be displayed for a given number.  Examples of algorithmic
 * numbering systems include Roman numerals, Chinese numerals, and Hebrew numerals.
 * Formatting rules for many commonly used numbering systems are included in
 * the ICU package, based on the numbering system rules defined in CLDR.
 * Alternate numbering systems can be specified to a locale by using the
 * numbers locale keyword.
 */

class U_I18N_API NumberingSystem : public UObject {
public:

    /**
     * Default Constructor.
     *
     * @stable ICU 4.2
     */
    NumberingSystem();

    /**
     * Copy constructor.
     * @stable ICU 4.2
     */
    NumberingSystem(const NumberingSystem& other);

    /**
     * Copy assignment.
     * @stable ICU 4.2
     */
    NumberingSystem& operator=(const NumberingSystem& other) = default;

    /**
     * Destructor.
     * @stable ICU 4.2
     */
    virtual ~NumberingSystem();

    /**
     * Create the default numbering system associated with the specified locale.
     * @param inLocale The given locale.
     * @param status ICU status
     * @stable ICU 4.2
     */
    static NumberingSystem* U_EXPORT2 createInstance(const Locale & inLocale, UErrorCode& status);

    /**
     * Create the default numbering system associated with the default locale.
     * @stable ICU 4.2
     */
    static NumberingSystem* U_EXPORT2 createInstance(UErrorCode& status);

    /**
     * Create a numbering system using the specified radix, type, and description. 
     * @param radix         The radix (base) for this numbering system.
     * @param isAlgorithmic true if the numbering system is algorithmic rather than numeric.
     * @param description   The string representing the set of digits used in a numeric system, or the name of the RBNF
     *                      ruleset to be used in an algorithmic system.
     * @param status ICU status
     * @stable ICU 4.2
     */
    static NumberingSystem* U_EXPORT2 createInstance(int32_t radix, UBool isAlgorithmic, const UnicodeString& description, UErrorCode& status );

    /**
     * Return a StringEnumeration over all the names of numbering systems known to ICU.
     * The numbering system names will be in alphabetical (invariant) order.
     *
     * The returned StringEnumeration is owned by the caller, who must delete it when
     * finished with it.
     *
     * @stable ICU 4.2
     */
     static StringEnumeration * U_EXPORT2 getAvailableNames(UErrorCode& status);

    /**
     * Create a numbering system from one of the predefined numbering systems specified
     * by CLDR and known to ICU, such as "latn", "arabext", or "hanidec"; the full list
     * is returned by unumsys_openAvailableNames. Note that some of the names listed at
     * http://unicode.org/repos/cldr/tags/latest/common/bcp47/number.xml - e.g.
     * default, native, traditional, finance - do not identify specific numbering systems,
     * but rather key values that may only be used as part of a locale, which in turn
     * defines how they are mapped to a specific numbering system such as "latn" or "hant".
     *
     * @param name   The name of the numbering system.
     * @param status ICU status; set to U_UNSUPPORTED_ERROR if numbering system not found.
     * @return The NumberingSystem instance, or nullptr if not found.
     * @stable ICU 4.2
     */
    static NumberingSystem* U_EXPORT2 createInstanceByName(const char* name, UErrorCode& status);


    /**
     * Returns the radix of this numbering system. Simple positional numbering systems
     * typically have radix 10, but might have a radix of e.g. 16 for hexadecimal. The
     * radix is less well-defined for non-positional algorithmic systems.
     * @stable ICU 4.2
     */
    int32_t getRadix() const;

    /**
     * Returns the name of this numbering system if it was created using one of the predefined names
     * known to ICU.  Otherwise, returns nullptr.
     * The predefined names are identical to the numbering system names as defined by
     * the BCP47 definition in Unicode CLDR.
     * See also, http://www.unicode.org/repos/cldr/tags/latest/common/bcp47/number.xml
     * @stable ICU 4.6
     */
    const char * getName() const;

    /**
     * Returns the description string of this numbering system. For simple
     * positional systems this is the ordered string of digits (with length matching
     * the radix), e.g. "\u3007\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D"
     * for "hanidec"; it would be "0123456789ABCDEF" for hexadecimal. For
     * algorithmic systems this is the name of the RBNF ruleset used for formatting,
     * e.g. "zh/SpelloutRules/%spellout-cardinal" for "hans" or "%greek-upper" for
     * "grek".
     * @stable ICU 4.2
     */
    virtual UnicodeString getDescription() const;



    /**
     * Returns true if the given numbering system is algorithmic
     *
     * @return         true if the numbering system is algorithmic.
     *                 Otherwise, return false.
     * @stable ICU 4.2
     */
    UBool isAlgorithmic() const;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 4.2
     *
    */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 4.2
     */
    virtual UClassID getDynamicClassID() const override;


private:
    UnicodeString   desc;
    int32_t         radix;
    UBool           algorithmic;
    char            name[kInternalNumSysNameCapacity+1];

    void setRadix(int32_t radix);

    void setAlgorithmic(UBool algorithmic);

    void setDesc(const UnicodeString &desc);

    void setName(const char* name);
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _NUMSYS
//eof
