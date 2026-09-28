{
  "targets": [
    {
      "target_name": "phase_e_maintainer",
      "sources": ["native/phase-e-maintainer.cc"],
      "conditions": [["OS=='win'", {"libraries": ["-lnetapi32", "-ladvapi32", "-lfwpuclnt", "-lcrypt32"]}]]
    }
  ]
}
