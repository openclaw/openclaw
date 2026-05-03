/* C implementation of performance sensitive functions. */

#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <stdint.h> /* uint8_t, uint32_t, uint64_t */

#if __ARM_NEON
#include <arm_neon.h>
#elif __SSE2__
#include <emmintrin.h>
#endif

static const Py_ssize_t MASK_LEN = 4;

/* Similar to PyBytes_AsStringAndSize, but accepts more types */

static int
_PyBytesLike_AsStringAndSize(PyObject *obj, PyObject **tmp, char **buffer, Py_ssize_t *length)
{
    // This supports bytes, bytearrays, and memoryview objects,
    // which are common data structures for handling byte streams.
    // If *tmp isn't NULL, the caller gets a new reference.
    if (PyBytes_Check(obj))
    {
        *tmp = NULL;
        *buffer = PyBytes_AS_STRING(obj);
        *length = PyBytes_GET_SIZE(obj);
    }
    else if (PyByteArray_Check(obj))
    {
        *tmp = NULL;
        *buffer = PyByteArray_AS_STRING(obj);
        *length = PyByteArray_GET_SIZE(obj);
    }
    else if (PyMemoryView_Check(obj))
    {
        *tmp = PyMemoryView_GetContiguous(obj, PyBUF_READ, 'C');
        if (*tmp == NULL)
        {
            return -1;
        }
        Py_buffer *mv_buf;
        mv_buf = PyMemoryView_GET_BUFFER(*tmp);
        *buffer = mv_buf->buf;
        *length = mv_buf->len;
    }
    else
    {
        PyErr_Format(
            PyExc_TypeError,
            "expected a bytes-like object, %.200s found",
            Py_TYPE(obj)->tp_name);
        return -1;
    }

    return 0;
}

/* C implementation of websockets.utils.apply_mask */

static PyObject *
apply_mask(PyObject *self, PyObject *args, PyObject *kwds)
{

    // In order to support various bytes-like types, accept any Python object.

    static char *kwlist[] = {"data", "mask", NULL};
    PyObject *input_obj;
    PyObject *mask_obj;

    // A pointer to a char * + length will be extracted from the data and mask
    // arguments, possibly via a Py_buffer.

    PyObject *input_tmp = NULL;
    char *input;
    Py_ssize_t input_len;
    PyObject *mask_tmp = NULL;
    char *mask;
    Py_ssize_t mask_len;

    // Initialize a PyBytesObject then get a pointer to the underlying char *
    // in order to avoid an extra memory copy in PyBytes_FromStringAndSize.

    PyObject *result = NULL;
    char *output;

    // Other variables.

    Py_ssize_t i = 0;

    // Parse inputs.

    if (!PyArg_ParseTupleAndKeywords(
            args, kwds, "OO", kwlist, &input_obj, &mask_obj))
    {
        goto exit;
    }

    if (_PyBytesLike_AsStringAndSize(input_obj, &input_tmp, &input, &input_len) == -1)
    {
        goto exit;
    }

    if (_PyBytesLike_AsStringAndSize(mask_obj, &mask_tmp, &mask, &mask_len) == -1)
    {
        goto exit;
    }

    if (mask_len != MASK_LEN)
    {
        PyErr_SetString(PyExc_ValueError, "mask must contain 4 bytes");
        goto exit;
    }

    // Create output.

    result = PyBytes_FromStringAndSize(NULL, input_len);
    if (result == NULL)
    {
        goto exit;
    }

    // Since we just created result, we don't need error checks.
    output = PyBytes_AS_STRING(result);

    // Perform the masking operation.

    // Apparently GCC cannot figure out the following optimizations by itself.

    // We need a new scope for MSVC 2010 (non C99 friendly)
    {
#if __ARM_NEON

        // With NEON support, XOR by blocks of 16 bytes = 128 bits.

        Py_ssize_t input_len_128 = input_len & ~15;
        uint8x16_t mask_128 = vreinterpretq_u8_u32(vdupq_n_u32(*(uint32_t *)mask));

        for (; i < input_len_128; i += 16)
        {
            uint8x16_t in_128 = vld1q_u8((uint8_t *)(input + i));
            uint8x16_t out_128 = veorq_u8(in_128, mask_128);
            vst1q_u8((uint8_t *)(output + i), out_128);
        }

#elif __SSE2__

        // With SSE2 support, XOR by blocks of 16 bytes = 128 bits.

        // Since we cannot control the 16-bytes alignment of input and output
        // buffers, we rely on loadu/storeu rather than load/store.

        Py_ssize_t input_len_128 = input_len & ~15;
        __m128i mask_128 = _mm_set1_epi32(*(uint32_t *)mask);

        for (; i < input_len_128; i += 16)
        {
            __m128i in_128 = _mm_loadu_si128((__m128i *)(input + i));
            __m128i out_128 = _mm_xor_si128(in_128, mask_128);
            _mm_storeu_si128((__m128i *)(output + i), out_128);
        }

#else

        // Without SSE2 support, XOR by blocks of 8 bytes = 64 bits.

        // We assume the memory allocator aligns everything on 8 bytes boundaries.

        Py_ssize_t input_len_64 = input_len & ~7;
        uint32_t mask_32 = *(uint32_t *)mask;
        uint64_t mask_64 = ((uint64_t)mask_32 << 32) | (uint64_t)mask_32;

        for (; i < input_len_64; i += 8)
        {
            *(uint64_t *)(output + i) = *(uint64_t *)(input + i) ^ mask_64;
        }

#endif
    }

    // XOR the remainder of the input byte by byte.

    for (; i < input_len; i++)
    {
        output[i] = input[i] ^ mask[i & (MASK_LEN - 1)];
    }

exit:
    Py_XDECREF(input_tmp);
    Py_XDECREF(mask_tmp);
    return result;

}

static PyMethodDef speedups_methods[] = {
    {
        "apply_mask",
        (PyCFunction)apply_mask,
        METH_VARARGS | METH_KEYWORDS,
        "Apply masking to the data of a WebSocket message.",
    },
    {NULL, NULL, 0, NULL},      /* Sentinel */
};

static struct PyModuleDef speedups_module = {
    PyModuleDef_HEAD_INIT,
    "websocket.speedups",       /* m_name */
    "C implementation of performance sensitive functions.",
                                /* m_doc */
    -1,                         /* m_size */
    speedups_methods,           /* m_methods */
    NULL,
    NULL,
    NULL,
    NULL
};

PyMODINIT_FUNC
PyInit_speedups(void)
{
    PyObject *m = PyModule_Create(&speedups_module);
    if (m == NULL) {
        return NULL;
    }
#ifdef Py_GIL_DISABLED
    PyUnstable_Module_SetGIL(m, Py_MOD_GIL_NOT_USED);
#endif
    return m;
}
