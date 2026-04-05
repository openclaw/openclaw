# Copyright 2014 the V8 project authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.

# Print tagged object.
define job
call (void) _v8_internal_Print_Object((void*)($arg0))
end
document job
Print a v8 JavaScript object
Usage: job tagged_ptr
end

# Print content of V8 handles.
python
import gdb

class PrintV8HandleCommand(gdb.Command):
  """Print content of a V8 object, accessed through a handle."""

  def __init__(self, command_name):
    self.command_name = command_name
    super(PrintV8HandleCommand, self).__init__(command_name, gdb.COMMAND_DATA)

  @staticmethod
  def print_direct(value, from_tty):
    CMD = "call (void) _v8_internal_Print_Object((v8::internal::Address*)({}))"
    gdb.execute(CMD.format(value.format_string()), from_tty)
    return True

  @staticmethod
  def print_indirect(value, from_tty):
    CMD = "call (void) _v8_internal_Print_Object(*(v8::internal::Address**)({}))"
    gdb.execute(CMD.format(value.format_string()), from_tty)
    return True

  def invoke(self, arg, from_tty):
    argv = gdb.string_to_argv(arg)
    if len(argv) != 1:
      raise gdb.GdbError("{} takes exactly one argument.".format(
          self.command_name))
    value = gdb.parse_and_eval(argv[0])
    if not self.print_handle(value, from_tty):
      raise gdb.GdbError("{} cannot print a value of type {}".format(
        self.command_name, value.type))


class PrintV8LocalCommand(PrintV8HandleCommand):
  """Print content of v8::(Maybe)?Local."""

  def __init__(self):
    super(PrintV8LocalCommand, self).__init__("print-v8-local")

  def print_handle(self, value, from_tty):
    if gdb.types.get_basic_type(value.type).code != gdb.TYPE_CODE_STRUCT:
      return False
    # After https://crrev.com/c/4335544, v8::MaybeLocal contains a local_.
    if gdb.types.has_field(value.type, "local_"):
      value = value["local_"]
    # After https://crrev.com/c/4335544, v8::Local contains a location_.
    if gdb.types.has_field(value.type, "location_"):
      return self.print_indirect(value["location_"], from_tty)
    # Before https://crrev.com/c/4335544, v8::Local contained a val_.
    if gdb.types.has_field(value.type, "val_"):
      return self.print_indirect(value["val_"], from_tty)
    # With v8_enable_direct_local=true, v8::Local contains a ptr_.
    if gdb.types.has_field(value.type, "ptr_"):
      return self.print_direct(value["ptr_"], from_tty)
    # We don't know how to print this...
    return False

class PrintV8InternalHandleCommand(PrintV8HandleCommand):
  """Print content of v8::internal::(Maybe)?(Direct|Indirect)?Handle."""

  def __init__(self):
    super(PrintV8InternalHandleCommand, self).__init__("print-v8-internal-handle")

  def print_handle(self, value, from_tty):
    if gdb.types.get_basic_type(value.type).code != gdb.TYPE_CODE_STRUCT:
      return False
    # Indirect handles contain a location_.
    if gdb.types.has_field(value.type, "location_"):
      return self.print_indirect(value["location_"], from_tty)
    # Direct handles contain a obj_.
    if gdb.types.has_field(value.type, "obj_"):
      return self.print_direct(value["obj_"], from_tty)
    # We don't know how to print this...
    return False

PrintV8LocalCommand()
PrintV8InternalHandleCommand()
end

alias jlh = print-v8-local
alias jl = print-v8-local
alias jh = print-v8-internal-handle

# Print Code objects containing given PC.
define jco
  if $argc == 0
    call (void) _v8_internal_Print_Code((void*)($pc))
  else
    call (void) _v8_internal_Print_Code((void*)($arg0))
  end
end
document jco
Print a v8 Code object from an internal code address
Usage: jco pc
end

# Print Code objects assembly code surrounding given PC.
define jca
  if $argc == 0
    call (void) _v8_internal_Print_OnlyCode((void*)($pc), 30)
  else
    if $argc == 0
      call (void) _v8_internal_Print_OnlyCode((void*)($arg0), 30)
    else
      call (void) _v8_internal_Print_OnlyCode((void*)($arg0), (size_t)($arg1))
    end
  end
end
document jca
Print a v8 Code object assembly code from an internal code address
Usage: jca pc
end

# Print TransitionTree.
define jtt
call (void) _v8_internal_Print_TransitionTree((void*)($arg0))
end
document jtt
Print the complete transition tree of the given v8 Map.
Usage: jtt tagged_ptr
end

# Print JavaScript stack trace.
define jst
call (void) _v8_internal_Print_StackTrace()
end
document jst
Print the current JavaScript stack trace
Usage: jst
end

# Print TurboFan graph node.
define pn
call _v8_internal_Node_Print((void*)($arg0))
end
document pn
Print a v8 TurboFan graph node
Usage: pn node_address
end

# Skip the JavaScript stack.
define jss
set $js_entry_sp=v8::internal::Isolate::Current()->thread_local_top()->js_entry_sp_
set $rbp=*(void**)$js_entry_sp
set $rsp=$js_entry_sp + 2*sizeof(void*)
set $pc=*(void**)($js_entry_sp+sizeof(void*))
end
document jss
Skip the jitted stack on x64 to where we entered JS last.
Usage: jss
end

# Execute a simulator command.
python
import gdb

class SimCommand(gdb.Command):
  """Sim the current program."""

  def __init__ (self):
    super (SimCommand, self).__init__ ("sim", gdb.COMMAND_SUPPORT)

  def invoke (self, arg, from_tty):
    arg_bytes = arg.encode("utf-8") + b'\0'
    arg_c_string = gdb.Value(arg_bytes, gdb.lookup_type('char').array(len(arg_bytes) - 1))
    cmd_func = gdb.selected_frame().read_var("_v8_internal_Simulator_ExecDebugCommand")
    cmd_func(arg_c_string)

SimCommand()
end

# Print stack trace with assertion scopes.
define bta
python
import re
frame_re = re.compile("^#(\d+)\s*(?:0x[a-f\d]+ in )?(.+) \(.+ at (.+)")
assert_re = re.compile("^\s*(\S+) = .+<v8::internal::Per\w+AssertScope<v8::internal::(\S*), (false|true)>")
btl = gdb.execute("backtrace full", to_string = True).splitlines()
for l in btl:
  match = frame_re.match(l)
  if match:
    print("[%-2s] %-60s %-40s" % (match.group(1), match.group(2), match.group(3)))
  match = assert_re.match(l)
  if match:
    if match.group(3) == "false":
      prefix = "Disallow"
      color = "\033[91m"
    else:
      prefix = "Allow"
      color = "\033[92m"
    print("%s -> %s %s (%s)\033[0m" % (color, prefix, match.group(2), match.group(1)))
end
end
document bta
Print stack trace with assertion scopes
Usage: bta
end

# Search for a pointer inside all valid pages.
define space_find
  set $space = $arg0
  set $current_page = $space->first_page()
  while ($current_page != 0)
    printf "#   Searching in %p - %p\n", $current_page->area_start(), $current_page->area_end()-1
    find $current_page->area_start(), $current_page->area_end()-1, $arg1
    set $current_page = $current_page->next_page()
  end
end

define heap_find
  set $heap = v8::internal::Isolate::Current()->heap()
  printf "# Searching for %p in old_space  ===============================\n", $arg0
  space_find $heap->old_space() ($arg0)
  printf "# Searching for %p in map_space  ===============================\n", $arg0
  space_find $heap->map_space() $arg0
  printf "# Searching for %p in code_space ===============================\n", $arg0
  space_find $heap->code_space() $arg0
end
document heap_find
Find the location of a given address in V8 pages.
Usage: heap_find address
end

# The 'disassembly-flavor' command is only available on i386 and x84_64.
python
try:
  gdb.execute("set disassembly-flavor intel")
except gdb.error:
  pass
end

# Configuring ASLR may not be possible on some platforms, such running via the
# `rr` debuggger.
python
try:
  gdb.execute("set disable-randomization off")
except gdb.error:
  pass
end

# Install a handler whenever the debugger stops due to a signal. It walks up the
# stack looking for V8_Dcheck / V8_Fatal / OS::DebugBreak frame and moves the
# frame to the one above it so it's immediately at the line of code that
# triggered the stop condition.
python
def v8_stop_handler(event):
  frame = gdb.selected_frame()
  select_frame = None
  message = None
  count = 0
  # Limit stack scanning since the frames we look for are near the top anyway,
  # and otherwise stack overflows can be very slow.
  while frame is not None and count < 10:
    count += 1
    # If we are in a frame created by gdb (e.g. for `(gdb) call foo()`), gdb
    # emits a dummy frame between its stack and the program's stack. Abort the
    # walk if we see this frame.
    if frame.type() == gdb.DUMMY_FRAME: break

    if frame.name() == 'V8_Dcheck':
      frame_message = gdb.lookup_symbol('message', frame.block())[0]
      if frame_message:
        message = frame_message.value(frame).string()
      select_frame = frame.older()
      break
    if frame.name() is not None and frame.name().startswith('V8_Fatal'):
      select_frame = frame.older()
    if frame.name() == 'v8::base::OS::DebugBreak':
      select_frame = frame.older()
    frame = frame.older()

  if select_frame is not None:
    select_frame.select()
    gdb.execute('frame')
    if message:
      print('DCHECK error: {}'.format(message))

gdb.events.stop.connect(v8_stop_handler)
end

# Code imported from chromium/src/tools/gdb/gdbinit
python

import os
import subprocess
import sys

compile_dirs = set()


def get_current_debug_file_directories():
  dir = gdb.execute("show debug-file-directory", to_string=True)
  dir = dir[
      len('The directory where separate debug symbols are searched for is "'
         ):-len('".') - 1]
  return set(dir.split(":"))


def add_debug_file_directory(dir):
  # gdb has no function to add debug-file-directory, simulates that by using
  # `show debug-file-directory` and `set debug-file-directory <directories>`.
  current_dirs = get_current_debug_file_directories()
  current_dirs.add(dir)
  gdb.execute(
      "set debug-file-directory %s" % ":".join(current_dirs), to_string=True)


def newobj_handler(event):
  global compile_dirs
  compile_dir = os.path.dirname(event.new_objfile.filename)
  if not compile_dir:
    return
  if compile_dir in compile_dirs:
    return
  compile_dirs.add(compile_dir)

  # Add source path
  gdb.execute("dir %s" % compile_dir)

  # Need to tell the location of .dwo files.
  # https://sourceware.org/gdb/onlinedocs/gdb/Separate-Debug-Files.html
  # https://crbug.com/603286#c35
  add_debug_file_directory(compile_dir)

# Event hook for newly loaded objfiles.
# https://sourceware.org/gdb/onlinedocs/gdb/Events-In-Python.html
gdb.events.new_objfile.connect(newobj_handler)

gdb.execute("set environment V8_GDBINIT_SOURCED=1")

end

### CppGC helpers.

# Print compressed pointer.
define cpcp
call _cppgc_internal_Decompress_Compressed_Pointer((unsigned)($arg0))
end
document cpcp
Prints compressed pointer (raw value) after decompression.
Usage: cpcp compressed_pointer
end

# Print member.
define cpm
call _cppgc_internal_Print_Member((cppgc::internal::MemberBase*)(&$arg0))
end
document cpm
Prints member, compressed or not.
Usage: cpm member
end

# Pretty printer for cppgc::Member.
python

import re


class CppGCMemberPrinter(object):
  """Print cppgc Member types."""

  def __init__(self, val, category, pointee_type):
    self.val = val
    self.category = category
    self.pointee_type = pointee_type

  def to_string(self):
    pointer = gdb.parse_and_eval(
        "_cppgc_internal_Uncompress_Member((void*){})".format(
            self.val.address))
    return "{}Member<{}> pointing to {}".format(
        '' if self.category is None else self.category, self.pointee_type,
        pointer)

  def display_hint(self):
    return "{}Member<{}>".format('' if self.category is None else self.category,
                                 self.pointee_type)


def cppgc_pretty_printers(val):
  typename = val.type.name or val.type.tag or str(val.type)
  regex = re.compile("^(cppgc|blink)::(Weak|Untraced)?Member<(.*)>$")
  match = regex.match(typename)
  if match is not None:
    return CppGCMemberPrinter(
        val, category=match.group(2), pointee_type=match.group(3))

  # The member type might have been obscured by typedefs and template
  # arguments. Fallback to using the underlying type.
  real_type = val.type.strip_typedefs()
  if (real_type.name is not None and
      real_type.name.startswith('cppgc::internal::BasicMember')):
    inner_type = real_type.template_argument(0)
    return CppGCMemberPrinter(
        val, category='Basic', pointee_type=inner_type.name)

  return None


gdb.pretty_printers.append(cppgc_pretty_printers)

end
