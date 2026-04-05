// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_SNAPSHOT_H_
#define INCLUDE_V8_SNAPSHOT_H_

#include "v8-internal.h"      // NOLINT(build/include_directory)
#include "v8-isolate.h"       // NOLINT(build/include_directory)
#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Object;

namespace internal {
class SnapshotCreatorImpl;
}  // namespace internal

class V8_EXPORT StartupData {
 public:
  /**
   * Whether the data created can be rehashed and and the hash seed can be
   * recomputed when deserialized.
   * Only valid for StartupData returned by SnapshotCreator::CreateBlob().
   */
  bool CanBeRehashed() const;
  /**
   * Allows embedders to verify whether the data is valid for the current
   * V8 instance.
   */
  bool IsValid() const;

  const char* data;
  int raw_size;
};

/**
 * Callback and supporting data used in SnapshotCreator to implement embedder
 * logic to serialize internal fields of v8::Objects.
 * Internal fields that directly reference V8 objects are serialized without
 * calling this callback. Internal fields that contain aligned pointers are
 * serialized by this callback if it returns non-zero result. Otherwise it is
 * serialized verbatim.
 */
struct SerializeInternalFieldsCallback {
  using CallbackFunction = StartupData (*)(Local<Object> holder, int index,
                                           void* data);
  SerializeInternalFieldsCallback(CallbackFunction function = nullptr,
                                  void* data_arg = nullptr)
      : callback(function), data(data_arg) {}
  CallbackFunction callback;
  void* data;
};

/**
 * Similar to SerializeInternalFieldsCallback, but works with the embedder data
 * in a v8::Context.
 */
struct SerializeContextDataCallback {
  using CallbackFunction = StartupData (*)(Local<Context> holder, int index,
                                           void* data);
  SerializeContextDataCallback(CallbackFunction function = nullptr,
                               void* data_arg = nullptr)
      : callback(function), data(data_arg) {}
  CallbackFunction callback;
  void* data;
};

/**
 * Callback and supporting data used to implement embedder logic to deserialize
 * internal fields of v8::Objects.
 */
struct DeserializeInternalFieldsCallback {
  using CallbackFunction = void (*)(Local<Object> holder, int index,
                                    StartupData payload, void* data);
  DeserializeInternalFieldsCallback(CallbackFunction function = nullptr,
                                    void* data_arg = nullptr)
      : callback(function), data(data_arg) {}

  CallbackFunction callback;
  void* data;
};

/**
 * Similar to DeserializeInternalFieldsCallback, but works with the embedder
 * data in a v8::Context.
 */
struct DeserializeContextDataCallback {
  using CallbackFunction = void (*)(Local<Context> holder, int index,
                                    StartupData payload, void* data);
  DeserializeContextDataCallback(CallbackFunction function = nullptr,
                                 void* data_arg = nullptr)
      : callback(function), data(data_arg) {}
  CallbackFunction callback;
  void* data;
};

/**
 * Helper class to create a snapshot data blob.
 *
 * The Isolate used by a SnapshotCreator is owned by it, and will be entered
 * and exited by the constructor and destructor, respectively; The destructor
 * will also destroy the Isolate. Experimental language features, including
 * those available by default, are not available while creating a snapshot.
 */
class V8_EXPORT SnapshotCreator {
 public:
  enum class FunctionCodeHandling { kClear, kKeep };

  /**
   * Initialize and enter an isolate, and set it up for serialization.
   * The isolate is either created from scratch or from an existing snapshot.
   * The caller keeps ownership of the argument snapshot.
   * \param existing_blob existing snapshot from which to create this one.
   * \param external_references a null-terminated array of external references
   *        that must be equivalent to CreateParams::external_references.
   * \param owns_isolate whether this SnapshotCreator should call
   *        v8::Isolate::Dispose() during its destructor.
   */
  V8_DEPRECATE_SOON("Use the version that passes CreateParams instead.")
  explicit SnapshotCreator(Isolate* isolate,
                           const intptr_t* external_references = nullptr,
                           const StartupData* existing_blob = nullptr,
                           bool owns_isolate = true);

  /**
   * Create and enter an isolate, and set it up for serialization.
   * The isolate is either created from scratch or from an existing snapshot.
   * The caller keeps ownership of the argument snapshot.
   * \param existing_blob existing snapshot from which to create this one.
   * \param external_references a null-terminated array of external references
   *        that must be equivalent to CreateParams::external_references.
   */
  V8_DEPRECATE_SOON("Use the version that passes CreateParams instead.")
  explicit SnapshotCreator(const intptr_t* external_references = nullptr,
                           const StartupData* existing_blob = nullptr);

  /**
   * Creates an Isolate for serialization and enters it. The creator fully owns
   * the Isolate and will invoke `v8::Isolate::Dispose()` during destruction.
   *
   * \param params The parameters to initialize the Isolate for. Details:
   *               - `params.external_references` are expected to be a
   *                 null-terminated array of external references.
   *               - `params.existing_blob` is an optional snapshot blob from
   *                 which can be used to initialize the new blob.
   */
  explicit SnapshotCreator(const v8::Isolate::CreateParams& params);

  /**
   * Initializes an Isolate for serialization and enters it. The creator does
   * not own the Isolate but merely initialize it properly.
   *
   * \param isolate The isolate that was allocated by `Isolate::Allocate()~.
   * \param params The parameters to initialize the Isolate for. Details:
   *               - `params.external_references` are expected to be a
   *                 null-terminated array of external references.
   *               - `params.existing_blob` is an optional snapshot blob from
   *                 which can be used to initialize the new blob.
   */
  SnapshotCreator(v8::Isolate* isolate,
                  const v8::Isolate::CreateParams& params);

  /**
   * Destroy the snapshot creator, and exit and dispose of the Isolate
   * associated with it.
   */
  ~SnapshotCreator();

  /**
   * \returns the isolate prepared by the snapshot creator.
   */
  Isolate* GetIsolate();

  /**
   * Set the default context to be included in the snapshot blob.
   * The snapshot will not contain the global proxy, and we expect one or a
   * global object template to create one, to be provided upon deserialization.
   *
   * \param internal_fields_serializer An optional callback used to serialize
   * internal pointer fields set by
   * v8::Object::SetAlignedPointerInInternalField().
   *
   * \param context_data_serializer An optional callback used to serialize
   * context embedder data set by
   * v8::Context::SetAlignedPointerInEmbedderData().
   *
   */
  void SetDefaultContext(
      Local<Context> context,
      SerializeInternalFieldsCallback internal_fields_serializer =
          SerializeInternalFieldsCallback(),
      SerializeContextDataCallback context_data_serializer =
          SerializeContextDataCallback());

  /**
   * Add additional context to be included in the snapshot blob.
   * The snapshot will include the global proxy.
   *
   * \param internal_fields_serializer Similar to internal_fields_serializer
   * in SetDefaultContext() but only applies to the context being added.
   *
   * \param context_data_serializer Similar to context_data_serializer
   * in SetDefaultContext() but only applies to the context being added.
   */
  size_t AddContext(Local<Context> context,
                    SerializeInternalFieldsCallback internal_fields_serializer =
                        SerializeInternalFieldsCallback(),
                    SerializeContextDataCallback context_data_serializer =
                        SerializeContextDataCallback());

  /**
   * Attach arbitrary V8::Data to the context snapshot, which can be retrieved
   * via Context::GetDataFromSnapshotOnce after deserialization. This data does
   * not survive when a new snapshot is created from an existing snapshot.
   * \returns the index for retrieval.
   */
  template <class T>
  V8_INLINE size_t AddData(Local<Context> context, Local<T> object);

  /**
   * Attach arbitrary V8::Data to the isolate snapshot, which can be retrieved
   * via Isolate::GetDataFromSnapshotOnce after deserialization. This data does
   * not survive when a new snapshot is created from an existing snapshot.
   * \returns the index for retrieval.
   */
  template <class T>
  V8_INLINE size_t AddData(Local<T> object);

  /**
   * Created a snapshot data blob.
   * This must not be called from within a handle scope.
   * \param function_code_handling whether to include compiled function code
   *        in the snapshot.
   * \returns { nullptr, 0 } on failure, and a startup snapshot on success. The
   *        caller acquires ownership of the data array in the return value.
   */
  StartupData CreateBlob(FunctionCodeHandling function_code_handling);

  // Disallow copying and assigning.
  SnapshotCreator(const SnapshotCreator&) = delete;
  void operator=(const SnapshotCreator&) = delete;

 private:
  size_t AddData(Local<Context> context, internal::Address object);
  size_t AddData(internal::Address object);

  internal::SnapshotCreatorImpl* impl_;
  friend class internal::SnapshotCreatorImpl;
};

template <class T>
size_t SnapshotCreator::AddData(Local<Context> context, Local<T> object) {
  return AddData(context, internal::ValueHelper::ValueAsAddress(*object));
}

template <class T>
size_t SnapshotCreator::AddData(Local<T> object) {
  return AddData(internal::ValueHelper::ValueAsAddress(*object));
}

}  // namespace v8

#endif  // INCLUDE_V8_SNAPSHOT_H_
