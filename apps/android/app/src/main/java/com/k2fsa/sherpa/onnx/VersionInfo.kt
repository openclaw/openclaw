package com.k2fsa.sherpa.onnx

class VersionInfo {
    companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }

        val version: String
            get() = getVersionStr2()

        val gitSha1: String
            get() = getGitSha12()

        val gitDate: String
            get() = getGitDate2()

        external fun getVersionStr2(): String
        external fun getGitSha12(): String
        external fun getGitDate2(): String
    }
}
