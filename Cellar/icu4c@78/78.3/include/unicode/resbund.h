// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*
*   Copyright (C) 1996-2013, International Business Machines Corporation
*   and others.  All Rights Reserved.
*
******************************************************************************
*
* File resbund.h
*
*   CREATED BY
*       Richard Gillam
*
* Modification History:
*
*   Date        Name        Description
*   2/5/97      aliu        Added scanForLocaleInFile.  Added
*                           constructor which attempts to read resource bundle
*                           from a specific file, without searching other files.
*   2/11/97     aliu        Added UErrorCode return values to constructors.  Fixed
*                           infinite loops in scanForFile and scanForLocale.
*                           Modified getRawResourceData to not delete storage
*                           in localeData and resourceData which it doesn't own.
*                           Added Mac compatibility #ifdefs for tellp() and
*                           ios::nocreate.
*   2/18/97     helena      Updated with 100% documentation coverage.
*   3/13/97     aliu        Rewrote to load in entire resource bundle and store
*                           it as a Hashtable of ResourceBundleData objects.
*                           Added state table to govern parsing of files.
*                           Modified to load locale index out of new file
*                           distinct from default.txt.
*   3/25/97     aliu        Modified to support 2-d arrays, needed for timezone
*                           data. Added support for custom file suffixes.  Again,
*                           needed to support timezone data.
*   4/7/97      aliu        Cleaned up.
* 03/02/99      stephen     Removed dependency on FILE*.
* 03/29/99      helena      Merged Bertrand and Stephen's changes.
* 06/11/99      stephen     Removed parsing of .txt files.
*                           Reworked to use new binary format.
*                           Cleaned up.
* 06/14/99      stephen     Removed methods taking a filename suffix.
* 11/09/99      weiv        Added getLocale(), fRealLocale, removed fRealLocaleID
******************************************************************************
*/

#ifndef RESBUND_H
#define RESBUND_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/uobject.h"
#include "unicode/ures.h"
#include "unicode/unistr.h"
#include "unicode/locid.h"

/**
 * \file 
 * \brief C++ API: Resource Bundle
 */
 
U_NAMESPACE_BEGIN

/**
 * A class representing a collection of resource information pertaining to a given
 * locale. A resource bundle provides a way of accessing locale- specific information in
 * a data file. You create a resource bundle that manages the resources for a given
 * locale and then ask it for individual resources.
 * <P>
 * Resource bundles in ICU4C are currently defined using text files which conform to the following
 * <a href="https://github.com/unicode-org/icu-docs/blob/main/design/bnf_rb.txt">BNF definition</a>.
 * More on resource bundle concepts and syntax can be found in the
 * <a href="https://unicode-org.github.io/icu/userguide/locale/resources">Users Guide</a>.
 * <P>
 *
 * The ResourceBundle class is not suitable for subclassing.
 *
 * @stable ICU 2.0
 */
class U_COMMON_API ResourceBundle : public UObject {
public:
    /**
     * Constructor
     *
     * @param packageName   The packageName and locale together point to an ICU udata object, 
     *                      as defined by <code> udata_open( packageName, "res", locale, err) </code> 
     *                      or equivalent.  Typically, packageName will refer to a (.dat) file, or to
     *                      a package registered with udata_setAppData(). Using a full file or directory
     *                      pathname for packageName is deprecated.
     * @param locale  This is the locale this resource bundle is for. To get resources
     *                for the French locale, for example, you would create a
     *                ResourceBundle passing Locale::FRENCH for the "locale" parameter,
     *                and all subsequent calls to that resource bundle will return
     *                resources that pertain to the French locale. If the caller doesn't
     *                pass a locale parameter, the default locale for the system (as
     *                returned by Locale::getDefault()) will be used.
     * @param err     The Error Code.
     * The UErrorCode& err parameter is used to return status information to the user. To
     * check whether the construction succeeded or not, you should check the value of
     * U_SUCCESS(err). If you wish more detailed information, you can check for
     * informational error results which still indicate success. U_USING_FALLBACK_WARNING
     * indicates that a fall back locale was used. For example, 'de_CH' was requested,
     * but nothing was found there, so 'de' was used. U_USING_DEFAULT_WARNING indicates that
     * the default locale data was used; neither the requested locale nor any of its
     * fall back locales could be found.
     * @stable ICU 2.0
     */
    ResourceBundle(const UnicodeString&    packageName,
                   const Locale&           locale,
                   UErrorCode&              err);

    /**
     * Construct a resource bundle for the default bundle in the specified package.
     *
     * @param packageName   The packageName and locale together point to an ICU udata object, 
     *                      as defined by <code> udata_open( packageName, "res", locale, err) </code> 
     *                      or equivalent.  Typically, packageName will refer to a (.dat) file, or to
     *                      a package registered with udata_setAppData(). Using a full file or directory
     *                      pathname for packageName is deprecated.
     * @param err A UErrorCode value
     * @stable ICU 2.0
     */
    ResourceBundle(const UnicodeString&    packageName,
                   UErrorCode&              err);

    /**
     * Construct a resource bundle for the ICU default bundle.
     *
     * @param err A UErrorCode value
     * @stable ICU 2.0
     */
    ResourceBundle(UErrorCode &err);

    /**
     * Standard constructor, constructs a resource bundle for the locale-specific
     * bundle in the specified package.
     *
     * @param packageName   The packageName and locale together point to an ICU udata object, 
     *                      as defined by <code> udata_open( packageName, "res", locale, err) </code> 
     *                      or equivalent.  Typically, packageName will refer to a (.dat) file, or to
     *                      a package registered with udata_setAppData(). Using a full file or directory
     *                      pathname for packageName is deprecated.
     *                      nullptr is used to refer to ICU data.
     * @param locale The locale for which to open a resource bundle.
     * @param err A UErrorCode value
     * @stable ICU 2.0
     */
    ResourceBundle(const char* packageName,
                   const Locale& locale,
                   UErrorCode& err);

    /**
     * Copy constructor.
     *
     * @param original The resource bundle to copy.
     * @stable ICU 2.0
     */
    ResourceBundle(const ResourceBundle &original);

    /**
     * Constructor from a C UResourceBundle. The resource bundle is
     * copied and not adopted. ures_close will still need to be used on the
     * original resource bundle.
     *
     * @param res A pointer to the C resource bundle.
     * @param status A UErrorCode value.
     * @stable ICU 2.0
     */
    ResourceBundle(UResourceBundle *res,
                   UErrorCode &status);

    /**
     * Assignment operator.
     *
     * @param other The resource bundle to copy.
     * @stable ICU 2.0
     */
    ResourceBundle&
      operator=(const ResourceBundle& other);

    /** Destructor.
     * @stable ICU 2.0
     */
    virtual ~ResourceBundle();

    /**
     * Clone this object.
     * Clones can be used concurrently in multiple threads.
     * If an error occurs, then nullptr is returned.
     * The caller must delete the clone.
     *
     * @return a clone of this object
     *
     * @see getDynamicClassID
     * @stable ICU 2.8
     */
    ResourceBundle *clone() const;

    /**
     * Returns the size of a resource. Size for scalar types is always 1, and for vector/table types is
     * the number of child resources.
     * @warning Integer array is treated as a scalar type. There are no
     *          APIs to access individual members of an integer array. It
     *          is always returned as a whole.
     *
     * @return number of resources in a given resource.
     * @stable ICU 2.0
     */
    int32_t getSize() const;

    /**
     * returns a string from a string resource type
     *
     * @param status  fills in the outgoing error code
     *                could be <TT>U_MISSING_RESOURCE_ERROR</TT> if the key is not found
     *                could be a warning
     *                e.g.: <TT>U_USING_FALLBACK_WARNING</TT>,<TT>U_USING_DEFAULT_WARNING </TT>
     * @return a pointer to a zero-terminated char16_t array which lives in a memory mapped/DLL file.
     * @stable ICU 2.0
     */
    UnicodeString
      getString(UErrorCode& status) const;

    /**
     * returns a binary data from a resource. Can be used at most primitive resource types (binaries,
     * strings, ints)
     *
     * @param len     fills in the length of resulting byte chunk
     * @param status  fills in the outgoing error code
     *                could be <TT>U_MISSING_RESOURCE_ERROR</TT> if the key is not found
     *                could be a warning
     *                e.g.: <TT>U_USING_FALLBACK_WARNING</TT>,<TT>U_USING_DEFAULT_WARNING </TT>
     * @return a pointer to a chunk of unsigned bytes which live in a memory mapped/DLL file.
     * @stable ICU 2.0
     */
    const uint8_t*
      getBinary(int32_t& len, UErrorCode& status) const;


    /**
     * returns an integer vector from a resource.
     *
     * @param len     fills in the length of resulting integer vector
     * @param status  fills in the outgoing error code
     *                could be <TT>U_MISSING_RESOURCE_ERROR</TT> if the key is not found
     *                could be a warning
     *                e.g.: <TT>U_USING_FALLBACK_WARNING</TT>,<TT>U_USING_DEFAULT_WARNING </TT>
     * @return a pointer to a vector of integers that lives in a memory mapped/DLL file.
     * @stable ICU 2.0
     */
    const int32_t*
      getIntVector(int32_t& len, UErrorCode& status) const;

    /**
     * returns an unsigned integer from a resource.
     * This integer is originally 28 bits.
     *
     * @param status  fills in the outgoing error code
     *                could be <TT>U_MISSING_RESOURCE_ERROR</TT> if the key is not found
     *                could be a warning
     *                e.g.: <TT>U_USING_FALLBACK_WARNING</TT>,<TT>U_USING_DEFAULT_WARNING </TT>
     * @return an unsigned integer value
     * @stable ICU 2.0
     */
    uint32_t
      getUInt(UErrorCode& status) const;

    /**
     * returns a signed integer from a resource.
     * This integer is originally 28 bit and the sign gets propagated.
     *
     * @param status  fills in the outgoing error code
     *                could be <TT>U_MISSING_RESOURCE_ERROR</TT> if the key is not found
     *                could be a warning
     *                e.g.: <TT>U_USING_FALLBACK_WARNING</TT>,<TT>U_USING_DEFAULT_WARNING </TT>
     * @return a signed integer value
     * @stable ICU 2.0
     */
    int32_t
      getInt(UErrorCode& status) const;

    /**
     * Checks whether the resource has another element to iterate over.
     *
     * @return true if there are more elements, false if there is no more elements
     * @stable ICU 2.0
     */
    UBool hasNext() const;

    /**
     * Resets the internal context of a resource so that iteration starts from the first element.
     *
     * @stable ICU 2.0
     */
    void resetIterator();

    /**
     * Returns the key associated with this resource. Not all the resources have a key - only
     * those that are members of a table.
     *
     * @return a key associated to this resource, or nullptr if it doesn't have a key
     * @stable ICU 2.0
     */
    const char* getKey() const;

    /**
     * Gets the locale ID of the resource bundle as a string.
     * Same as getLocale().getName() .
     *
     * @return the locale ID of the resource bundle as a string
     * @stable ICU 2.0
     */
    const char* getName() const;

    /**
     * Returns the type of a resource. Available types are defined in enum UResType
     *
     * @return type of the given resource.
     * @stable ICU 2.0
     */
    UResType getType() const;

    /**
     * Returns the next resource in a given resource or nullptr if there are no more resources
     *
     * @param status            fills in the outgoing error code
     * @return                  ResourceBundle object.
     * @stable ICU 2.0
     */
    ResourceBundle
      getNext(UErrorCode& status);

    /**
     * Returns the next string in a resource or nullptr if there are no more resources
     * to iterate over.
     *
     * @param status            fills in the outgoing error code
     * @return an UnicodeString object.
     * @stable ICU 2.0
     */
    UnicodeString
      getNextString(UErrorCode& status);

    /**
     * Returns the next string in a resource or nullptr if there are no more resources
     * to iterate over.
     *
     * @param key               fill in for key associated with this string
     * @param status            fills in the outgoing error code
     * @return an UnicodeString object.
     * @stable ICU 2.0
     */
    UnicodeString
      getNextString(const char ** key,
                    UErrorCode& status);

    /**
     * Returns the resource in a resource at the specified index.
     *
     * @param index             an index to the wanted resource.
     * @param status            fills in the outgoing error code
     * @return                  ResourceBundle object. If there is an error, resource is invalid.
     * @stable ICU 2.0
     */
    ResourceBundle
      get(int32_t index,
          UErrorCode& status) const;

    /**
     * Returns the string in a given resource at the specified index.
     *
     * @param index             an index to the wanted string.
     * @param status            fills in the outgoing error code
     * @return                  an UnicodeString object. If there is an error, string is bogus
     * @stable ICU 2.0
     */
    UnicodeString
      getStringEx(int32_t index,
                  UErrorCode& status) const;

    /**
     * Returns a resource in a resource that has a given key. This procedure works only with table
     * resources.
     *
     * @param key               a key associated with the wanted resource
     * @param status            fills in the outgoing error code.
     * @return                  ResourceBundle object. If there is an error, resource is invalid.
     * @stable ICU 2.0
     */
    ResourceBundle
      get(const char* key,
          UErrorCode& status) const;

    /**
     * Returns a string in a resource that has a given key. This procedure works only with table
     * resources.
     *
     * @param key               a key associated with the wanted string
     * @param status            fills in the outgoing error code
     * @return                  an UnicodeString object. If there is an error, string is bogus
     * @stable ICU 2.0
     */
    UnicodeString
      getStringEx(const char* key,
                  UErrorCode& status) const;

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Return the version number associated with this ResourceBundle as a string. Please
     * use getVersion, as this method is going to be deprecated.
     *
     * @return  A version number string as specified in the resource bundle or its parent.
     *          The caller does not own this string.
     * @see getVersion
     * @deprecated ICU 2.8 Use getVersion instead.
     */
    const char* getVersionNumber() const;
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Return the version number associated with this ResourceBundle as a UVersionInfo array.
     *
     * @param versionInfo A UVersionInfo array that is filled with the version number
     *                    as specified in the resource bundle or its parent.
     * @stable ICU 2.0
     */
    void
      getVersion(UVersionInfo versionInfo) const;

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Return the Locale associated with this ResourceBundle.
     *
     * @return a Locale object
     * @deprecated ICU 2.8 Use getLocale(ULocDataLocaleType type, UErrorCode &status) overload instead.
     */
    const Locale& getLocale() const;
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Return the Locale associated with this ResourceBundle.
     * @param type You can choose between requested, valid and actual
     *             locale. For description see the definition of
     *             ULocDataLocaleType in uloc.h
     * @param status just for catching illegal arguments
     *
     * @return a Locale object
     * @stable ICU 2.8
     */
    Locale
      getLocale(ULocDataLocaleType type, UErrorCode &status) const;
#ifndef U_HIDE_INTERNAL_API
    /**
     * This API implements multilevel fallback
     * @internal
     */
    ResourceBundle
        getWithFallback(const char* key, UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */
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

private:
    ResourceBundle() = delete; // default constructor not implemented

    UResourceBundle *fResource;
    void constructForLocale(const UnicodeString& path, const Locale& locale, UErrorCode& error);
    Locale *fLocale;
};

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
