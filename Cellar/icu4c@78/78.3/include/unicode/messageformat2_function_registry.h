// © 2024 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#include "unicode/utypes.h"

#ifndef MESSAGEFORMAT2_FUNCTION_REGISTRY_H
#define MESSAGEFORMAT2_FUNCTION_REGISTRY_H

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_NORMALIZATION

#if !UCONFIG_NO_FORMATTING

#if !UCONFIG_NO_MF2

#include "unicode/messageformat2_data_model_names.h"
#include "unicode/messageformat2_formattable.h"

#ifndef U_HIDE_DEPRECATED_API

#include <map>

U_NAMESPACE_BEGIN

class Hashtable;
class UVector;

namespace message2 {

    using namespace data_model;

    /**
     * Interface that factory classes for creating formatters must implement.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API FormatterFactory : public UObject {
        // TODO: the coding guidelines say that interface classes
        // shouldn't inherit from UObject, but if I change it so these
        // classes don't, and the individual formatter factory classes
        // inherit from public FormatterFactory, public UObject, then
        // memory leaks ensue
    public:
        /**
         * Constructs a new formatter object. This method is not const;
         * formatter factories with local state may be defined.
         *
         * @param locale Locale to be used by the formatter.
         * @param status    Input/output error code.
         * @return The new Formatter, which is non-null if U_SUCCESS(status).
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual Formatter* createFormatter(const Locale& locale, UErrorCode& status) = 0;
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual ~FormatterFactory();
        /**
         * Copy constructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        FormatterFactory& operator=(const FormatterFactory&) = delete;
    }; // class FormatterFactory

    /**
     * Interface that factory classes for creating selectors must implement.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API SelectorFactory : public UObject {
    public:
        /**
         * Constructs a new selector object.
         *
         * @param locale    Locale to be used by the selector.
         * @param status    Input/output error code.
         * @return          The new selector, which is non-null if U_SUCCESS(status).
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual Selector* createSelector(const Locale& locale, UErrorCode& status) const = 0;
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual ~SelectorFactory();
        /**
         * Copy constructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        SelectorFactory& operator=(const SelectorFactory&) = delete;
    }; // class SelectorFactory

    /**
     * Defines mappings from names of formatters and selectors to functions implementing them.
     * The required set of formatter and selector functions is defined in the spec. Users can
     * also define custom formatter and selector functions.
     *
     * `MFFunctionRegistry` is immutable and movable. It is not copyable.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API MFFunctionRegistry : public UObject {
    private:

        using FormatterMap = Hashtable; // Map from stringified function names to FormatterFactory*
        using SelectorMap  = Hashtable; // Map from stringified function names to SelectorFactory*

    public:
        /**
         * Looks up a formatter factory by the name of the formatter. The result is non-const,
         * since formatter factories may have local state. Returns the result by pointer
         * rather than by reference since it can fail.
         *
         * @param formatterName Name of the desired formatter.
         * @return A pointer to the `FormatterFactory` registered under `formatterName`, or null
         *         if no formatter was registered under that name. The pointer is not owned
         *         by the caller.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        FormatterFactory* getFormatter(const FunctionName& formatterName) const;
        /**
         * Looks up a selector factory by the name of the selector. (This returns the result by pointer
         * rather than by reference since `FormatterFactory` is an abstract class.)
         *
         * @param selectorName Name of the desired selector.
         * @return A pointer to the `SelectorFactory` registered under `selectorName`, or null
         *         if no formatter was registered under that name.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        const SelectorFactory* getSelector(const FunctionName& selectorName) const;
        /**
         * Looks up a formatter factory by a type tag. This method gets the name of the default formatter registered
         * for that type. If no formatter was explicitly registered for this type, it returns false.
         *
         * @param formatterType Type tag for the desired `FormattableObject` type to be formatted.
         * @param name Output parameter; initialized to the name of the default formatter for `formatterType`
         *        if one has been registered. Its value is undefined otherwise.
         * @return True if and only if the function registry contains a default formatter for `formatterType`.
         *         If the return value is false, then the value of `name` is undefined.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        UBool getDefaultFormatterNameByType(const UnicodeString& formatterType, FunctionName& name) const;
        /**
         * The mutable Builder class allows each formatter and selector factory
         * to be initialized separately; calling its `build()` method yields an
         * immutable MFFunctionRegistry object.
         *
         * Builder is not copyable or movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Builder : public UObject {
        private:
            // Must use raw pointers to avoid instantiating `LocalPointer` on an internal type
            FormatterMap* formatters;
            SelectorMap* selectors;
            Hashtable* formattersByType;

            // Do not define copy constructor/assignment operator
            Builder& operator=(const Builder&) = delete;
            Builder(const Builder&) = delete;

        public:
            /*
              Notes about `adoptFormatter()`'s type signature:

              Alternative considered: take a non-owned FormatterFactory*
              This is unsafe.

              Alternative considered: take a FormatterFactory&
                 This requires getFormatter() to cast the reference to a pointer,
                 as it must return an unowned FormatterFactory* since it can fail.
                 That is also unsafe, since the caller could delete the pointer.

              The "TemperatureFormatter" test from the previous ICU4J version doesn't work now,
              as it only works if the `formatterFactory` argument is non-owned.
              If registering a non-owned FormatterFactory is desirable, this could
              be re-thought.
              */
            /**
             * Registers a formatter factory to a given formatter name.
             *
             * @param formatterName Name of the formatter being registered.
             * @param formatterFactory A pointer to a FormatterFactory object to use
             *        for creating `formatterName` formatters. This argument is adopted.
             * @param errorCode Input/output error code
             * @return A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder& adoptFormatter(const data_model::FunctionName& formatterName, FormatterFactory* formatterFactory, UErrorCode& errorCode);
            /**
             * Registers a formatter factory to a given type tag.
             * (See `FormattableObject` for details on type tags.)
             *
             * @param type Tag for objects to be formatted with this formatter.
             * @param functionName A reference to the name of the function to use for
             *        creating formatters for `formatterType` objects.
             * @param errorCode Input/output error code
             * @return A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder& setDefaultFormatterNameByType(const UnicodeString& type, const data_model::FunctionName& functionName, UErrorCode& errorCode);

            /**
             * Registers a selector factory to a given selector name. Adopts `selectorFactory`.
             *
             * @param selectorName Name of the selector being registered.
             * @param selectorFactory A SelectorFactory object to use for creating `selectorName`
             *        selectors.
             * @param errorCode Input/output error code
             * @return A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder& adoptSelector(const data_model::FunctionName& selectorName, SelectorFactory* selectorFactory, UErrorCode& errorCode);
            /**
             * Creates an immutable `MFFunctionRegistry` object with the selectors and formatters
             * that were previously registered. The builder cannot be used after this call.
             * The `build()` method is destructive to avoid the need for a deep copy of the
             * `FormatterFactory` and `SelectorFactory` objects (this would be necessary because
             * `FormatterFactory` can have mutable state), which in turn would require implementors
             * of those interfaces to implement a `clone()` method.
             *
             * @return The new MFFunctionRegistry
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            MFFunctionRegistry build();
            /**
             * Default constructor.
             * Returns a Builder with no functions registered.
             *
             * @param errorCode Input/output error code
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder(UErrorCode& errorCode);
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            virtual ~Builder();
        }; // class MFFunctionRegistry::Builder

        /**
         * Move assignment operator:
         * The source MFFunctionRegistry will be left in a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        MFFunctionRegistry& operator=(MFFunctionRegistry&&) noexcept;
        /**
         * Move constructor:
         * The source MFFunctionRegistry will be left in a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        MFFunctionRegistry(MFFunctionRegistry&& other) { *this = std::move(other); }
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual ~MFFunctionRegistry();

    private:
        friend class MessageContext;
        friend class MessageFormatter;

        // Do not define copy constructor or copy assignment operator
        MFFunctionRegistry& operator=(const MFFunctionRegistry&) = delete;
        MFFunctionRegistry(const MFFunctionRegistry&) = delete;

        MFFunctionRegistry(FormatterMap* f, SelectorMap* s, Hashtable* byType);

        MFFunctionRegistry() {}

        // Debugging; should only be called on a function registry with
        // all the standard functions registered
        void checkFormatter(const char*) const;
        void checkSelector(const char*) const;
        void checkStandard() const;

        bool hasFormatter(const data_model::FunctionName& f) const;
        bool hasSelector(const data_model::FunctionName& s) const;
        void cleanup() noexcept;

        // Must use raw pointers to avoid instantiating `LocalPointer` on an internal type
        FormatterMap* formatters = nullptr;
        SelectorMap* selectors = nullptr;
        // Mapping from strings (type tags) to FunctionNames
        Hashtable* formattersByType = nullptr;
    }; // class MFFunctionRegistry

    /**
     * Interface that formatter classes must implement.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API Formatter : public UObject {
    public:
        /**
         * Formats the input passed in `context` by setting an output using one of the
         * `FormattingContext` methods or indicating an error.
         *
         * @param toFormat Placeholder, including a source formattable value and possibly
         *        the output of a previous formatter applied to it; see
         *        `message2::FormattedPlaceholder` for details. Passed by move.
         * @param options The named function options. Passed by move
         * @param status    Input/output error code. Should not be set directly by the
         *        custom formatter, which should use `FormattingContext::setFormattingWarning()`
         *        to signal errors. The custom formatter may pass `status` to other ICU functions
         *        that can signal errors using this mechanism.
         *
         * @return The formatted value.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual FormattedPlaceholder format(FormattedPlaceholder&& toFormat,
                                      FunctionOptions&& options,
                                      UErrorCode& status) const = 0;
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual ~Formatter();
    }; // class Formatter

    /**
     * Interface that selector classes must implement.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API Selector : public UObject {
    public:
        /**
         * Compares the input to an array of keys, and returns an array of matching
         * keys sorted by preference.
         *
         * @param toFormat The unnamed function argument; passed by move.
         * @param options A reference to the named function options.
         * @param keys An array of strings that are compared to the input
         *        (`context.getFormattableInput()`) in an implementation-specific way.
         * @param keysLen The length of `keys`.
         * @param prefs An array of strings with length `keysLen`. The contents of
         *        the array is undefined. `selectKey()` should set the contents
         *        of `prefs` to a subset of `keys`, with the best match placed at the lowest index.
         * @param prefsLen A reference that `selectKey()` should set to the length of `prefs`,
         *        which must be less than or equal to `keysLen`.
         * @param status    Input/output error code. Should not be set directly by the
         *        custom selector, which should use `FormattingContext::setSelectorError()`
         *        to signal errors. The custom selector may pass `status` to other ICU functions
         *        that can signal errors using this mechanism.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual void selectKey(FormattedPlaceholder&& toFormat,
                               FunctionOptions&& options,
                               const UnicodeString* keys,
                               int32_t keysLen,
                               UnicodeString* prefs,
                               int32_t& prefsLen,
                               UErrorCode& status) const = 0;
        // Note: This takes array arguments because the internal MessageFormat code has to
        // call this method, and can't include any code that constructs std::vectors.
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual ~Selector();
    }; // class Selector

} // namespace message2

U_NAMESPACE_END

#endif // U_HIDE_DEPRECATED_API

#endif /* #if !UCONFIG_NO_MF2 */

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* #if !UCONFIG_NO_NORMALIZATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // MESSAGEFORMAT2_FUNCTION_REGISTRY_H

// eof
