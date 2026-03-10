# Introduction

Note that if you use Android Studio, then you only need to
copy libonnxruntime.so and libsherpa-onnx-jni.so
to your jniLibs, and you don't need libsherpa-onnx-c-api.so or
libsherpa-onnx-cxx-api.so.

libsherpa-onnx-c-api.so and libsherpa-onnx-cxx-api.so are for users
who don't use JNI. In that case, libsherpa-onnx-jni.so is not needed.

In any case, libonnxruntime.so is always needed.
