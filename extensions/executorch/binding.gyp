{
  "targets": [
    {
      "target_name": "parakeet_runtime",
      "sources": ["native/parakeet_runtime_addon.cc"],
      "cflags_cc": ["-std=c++17"],
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "CLANG_CXX_LIBRARY": "libc++"
            }
          }
        ],
        [
          "OS==\"win\"",
          {
            "defines": ["NOMINMAX"]
          }
        ],
        [
          "OS==\"linux\"",
          {
            "libraries": ["-ldl"]
          }
        ]
      ]
    }
  ]
}
