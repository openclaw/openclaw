# Copyright (c) 2021
#
# This file is part of FFmpeg.
#
# FFmpeg is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2.1 of the License, or (at your option) any later version.
#
# FFmpeg is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with FFmpeg; if not, write to the Free Software
# Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
# ==============================================================================

# verified with Python 3.6.8 on CentOS 7.2
import tensorflow as tf

visible_device_list = '0' # use , separator for more GPUs like '0, 1'
per_process_gpu_memory_fraction = 0.9 # avoid out of memory
intra_op_parallelism_threads = 2  # default in tensorflow
inter_op_parallelism_threads = 5  # default in tensorflow

gpu_options = tf.compat.v1.GPUOptions(
              per_process_gpu_memory_fraction = per_process_gpu_memory_fraction,
              visible_device_list = visible_device_list,
              allow_growth = True)

config = tf.compat.v1.ConfigProto(
         allow_soft_placement = True,
         log_device_placement = False,
         intra_op_parallelism_threads = intra_op_parallelism_threads,
         inter_op_parallelism_threads = inter_op_parallelism_threads,
         gpu_options = gpu_options)

s = config.SerializeToString()
# print(list(map(hex, s)))  # print by json if need

print('a serialized protobuf string for TF_SetConfig, note the byte order is in normal order.')
b = ''.join(format(b,'02x') for b in s)
print('0x%s' % b) # print by hex format
