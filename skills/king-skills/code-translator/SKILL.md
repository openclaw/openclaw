---
name: king_skill_code_translator
description: Translate code between languages (Python, GLSL, CUDA, OpenCL, Lean4, C, Rust, Julia) using automated tools and structured prompting.
metadata:
  {
    "openclaw":
      {
        "emoji": "🔄",
        "requires": { "bins": ["python3", "cargo"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "packages": ["cython"],
              "label": "Install Cython (pip)",
            },
            {
              "id": "cargo",
              "kind": "cargo",
              "crates": ["c2rust"],
              "label": "Install c2rust (cargo)",
            },
          ],
        "os": ["darwin", "linux", "win32"],
      },
  }
---

# Code Translator

Translate code between languages (Python, GLSL, CUDA, OpenCL, Lean4, C, Rust, Julia).

## When to Use

**USE this skill when:**
- Porting code between languages
- Converting Python to GLSL shaders
- CUDA to OpenCL translation
- OpenGL/WebGL compatibility
- GPU kernel development
- Cross-platform deployment

**DON'T use when:**
- Rewriting from scratch is cleaner
- Only syntax changes are needed

## Commands

### Python → C (Cython)

```bash
pip install cython
cython --embed -o output.c input.py
```

### C → Rust (c2rust)

```bash
cargo install c2rust
c2rust translate compile_commands.json
```

### GLSL Shader Template

```glsl
// Cellular automaton in GPU texture
#version 430
uniform sampler2D state;
uniform float time;
out vec4 fragColor;

void main() {
    vec2 uv = gl_FragCoord.xy / vec2(textureSize(state, 0));
    vec4 center = texture(state, uv);
    vec4 neighbors = (
        texture(state, uv + vec2( 1,  0) / vec2(textureSize(state, 0))) +
        texture(state, uv + vec2(-1,  0) / vec2(textureSize(state, 0))) +
        texture(state, uv + vec2( 0,  1) / vec2(textureSize(state, 0))) +
        texture(state, uv + vec2( 0, -1) / vec2(textureSize(state, 0)))
    ) * 0.25;
    fragColor = mix(center, neighbors, 0.1);
}
```

### OpenGL → WebGL Compatibility

```python
COMPAT = {
    "#version 430": "#version 300 es",
    "layout(binding=N)": "uniform",
    "image2D": "sampler2D",
    "imageLoad/imageStore": "texture/fragColor",
}
```

## Notes

- Critical for GPU/OpenGL shader work
- Token savings: 3/5
- Status: ✅ Verified
