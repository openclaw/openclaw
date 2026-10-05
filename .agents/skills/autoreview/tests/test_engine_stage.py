"""Portable synthetic tests for the opt-in local engine-stage observer."""
import os
import ast
import contextlib
import copy
import importlib.util
import importlib.machinery
import io
import json
from pathlib import Path
import queue
import runpy
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / 'scripts' / 'autoreview'
ARTIFACTS = Path.home()
LOADER = importlib.machinery.SourceFileLoader('candidate_autoreview', str(SOURCE))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
LOADER.exec_module(M)
CANARY = 'SYNTHETIC_CREDENTIAL_LIKE_VALUE'
REAL_POPEN = subprocess.Popen
PROCESSES = []
TEMP_PATHS = []

class FakeProcess:
    def __init__(self, stdout='', stderr=''):
        self.stdin = None
        self.stdout = io.StringIO(stdout)
        self.stderr = io.StringIO(stderr)
        self.pid = -123
        self.returncode = 0
    def poll(self): return self.returncode
    def wait(self, **kwargs): return self.returncode

@unittest.skipUnless(os.name == "posix", "private POSIX stage custody")
class StageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='stage-test.', dir=ARTIFACTS)
        self.root = Path(self.temporary.name)
        TEMP_PATHS.append(str(self.root))
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        self.output = self.root / 'output'
        self.output.mkdir(mode=0o700)
        self.threads_before = set(threading.enumerate())
    def tearDown(self):
        # All fixtures own their producers and reader threads; never kill foreign PIDs.
        for thread in set(threading.enumerate()) - self.threads_before:
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive(), 'synthetic reader thread survived')
        self.assertEqual(M._OWNED_PROCESSES, {})
        self.temporary.cleanup()
        self.assertFalse(self.root.exists())
    def stage(self):
        stage = M.EngineStage()
        self.assertIs(stage.claim(), stage)
        return stage
    def fake(self, stdout='', stderr='', *, suppress=False, activity=20, sink=None, stage=None):
        stage = stage or self.stage()
        display = M.CodexStreamDisplay(engine_stage=stage, suppress_diagnostics=suppress, activity_seconds=activity)
        proc = FakeProcess(stdout, stderr)
        out, err = sink or io.StringIO(), io.StringIO()
        with mock.patch.object(M.subprocess, 'Popen', return_value=proc), \
             mock.patch.object(M, 'terminate_process_group') as cleanup, \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = M.run_with_stream(['synthetic'], self.root, input_text=None, label='fixture',
                heartbeat_seconds=5, deadline=M.EngineRuntimeDeadline('fixture', 2),
                stream_display=display, engine_stage=stage, env={})
        self.assertEqual(cleanup.call_count, 1)
        return result, stage.snapshot(), out.getvalue(), err.getvalue()
    def real(self, script, *, timeout=1, stage=None, display=None):
        stage = stage or self.stage()
        display = display or M.CodexStreamDisplay(engine_stage=stage)
        out, err = io.StringIO(), io.StringIO()
        def launch(*args, **kwargs):
            proc = REAL_POPEN(*args, **kwargs)
            PROCESSES.append(proc)
            return proc
        begin = time.monotonic()
        with mock.patch.object(M.subprocess, 'Popen', side_effect=launch), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = M.run_with_heartbeat([sys.executable, '-I', '-S', '-B', '-c', script],
                self.root, input_text=None, label='synthetic', heartbeat_seconds=10,
                max_runtime_seconds=timeout, stream_output=True, stream_display=display,
                engine_stage=stage, env={'HOME':str(self.home), 'TMPDIR':str(self.home), 'PATH':os.environ.get('PATH', os.defpath), 'LANG':'C.UTF-8'})
        elapsed = time.monotonic() - begin
        proc = PROCESSES[-1]
        self.assertIsNotNone(proc.poll())
        with self.assertRaises(ProcessLookupError): os.killpg(proc.pid, 0)
        self.assertLess(elapsed, timeout + 5)
        return result, stage.snapshot(), out.getvalue(), err.getvalue()
    def assert_closed(self, snapshot):
        fields = {'schema_version','observation_kind','spoofable','provider_receipt','acceptance',
                  'launch_returned','stdout_text_read','stderr_text_read','stdout_delivered_to_display',
                  'stderr_delivered_to_display','stdout_json_object_seen','stdout_stage_type_seen',
                  'stage_display_generated_streams','stage_display_flushed_streams','terminal'}
        self.assertEqual(set(snapshot), fields)
        self.assertEqual(snapshot['schema_version'], 1)
        self.assertEqual(snapshot['observation_kind'], 'helper_local_stage')
        self.assertIs(snapshot['spoofable'], True)
        self.assertIs(snapshot['provider_receipt'], False)
        self.assertIs(snapshot['acceptance'], False)
        for key in fields - {'schema_version','observation_kind','stage_display_generated_streams',
                              'stage_display_flushed_streams','terminal'}:
            self.assertIs(type(snapshot[key]), bool)
        self.assertLessEqual(len(json.dumps(snapshot).encode()), 4096)
        self.assertNotIn(CANARY, json.dumps(snapshot))
    def test_no_output_timeout(self):
        result, x, out, err = self.real('import time; time.sleep(10)', timeout=.12)
        self.assertIsInstance(result, M.TimedOutEngineProcess)
        self.assertEqual(result.returncode,124)
        self.assertEqual(x['terminal'],'engine_timeout')
        self.assertTrue(x['launch_returned'])
        self.assertFalse(x['stdout_text_read'])
        self.assertFalse(x['stderr_text_read'])
        self.assertEqual(out,'')
        self.assert_closed(x)
    def test_partial_line_eof(self):
        result,x,out,err = self.real('import sys; sys.stdout.write("partial")')
        self.assertEqual(result.stdout,'partial')
        self.assertEqual(out,'partial')
        self.assertTrue(x['stdout_text_read'])
        self.assertTrue(x['stdout_delivered_to_display'])
        self.assertFalse(x['stdout_json_object_seen'])
    def test_partial_line_before_timeout(self):
        result,x,out,err = self.real('import sys,time; sys.stdout.write("partial"); sys.stdout.flush(); time.sleep(10)', timeout=.15)
        self.assertEqual(x['terminal'],'engine_timeout')
        self.assertEqual(result.stdout,'partial')
        self.assertTrue(x['stdout_text_read'])
    def test_nonzero_return_is_returned(self):
        result,x,_,_ = self.real('raise SystemExit(124)')
        self.assertNotIsInstance(result,M.TimedOutEngineProcess)
        self.assertEqual(result.returncode,124)
        self.assertEqual(x['terminal'],'returned')
    def test_malformed_and_nonobjects(self):
        for text in ('not json\n','[]\n','null\n','42\n','"text"\n'):
            with self.subTest(text=text):
                _,x,_,_ = self.fake(text)
                self.assertFalse(x['stdout_json_object_seen'])
                self.assertFalse(x['stdout_stage_type_seen'])
                self.assertEqual(x['stage_display_generated_streams'],'none')
    def test_unknown_object(self):
        _,x,out,_ = self.fake('{"type":"future.stage"}\n')
        self.assertTrue(x['stdout_json_object_seen'])
        self.assertFalse(x['stdout_stage_type_seen'])
        self.assertEqual(out,'')
    def test_recognized_stages(self):
        for kind in ('thread.started','turn.started','turn.completed'):
            with self.subTest(kind=kind):
                _,x,out,_ = self.fake(json.dumps({'type':kind})+'\n')
                self.assertTrue(x['stdout_stage_type_seen'])
                self.assertEqual(x['stage_display_generated_streams'],'stdout')
                self.assertEqual(x['stage_display_flushed_streams'],'stdout')
                self.assertTrue(out)
                self.assert_closed(x)
    def test_stderr_hidden_activity(self):
        _,x,out,err = self.fake(stderr=CANARY+'\n',suppress=True,activity=0)
        self.assertTrue(x['stderr_text_read'])
        self.assertTrue(x['stderr_delivered_to_display'])
        self.assertFalse(x['stdout_json_object_seen'])
        self.assertEqual(x['stage_display_generated_streams'],'stderr')
        self.assertEqual(x['stage_display_flushed_streams'],'stderr')
        self.assertEqual(out,'')
        self.assertEqual(err,'codex activity: 1 hidden tool/status events\n')
        self.assert_closed(x)
    def test_below_threshold_hidden_stays_unflushed(self):
        _,x,out,err = self.fake('{"type":"hidden"}\n',stderr=CANARY+'\n',suppress=True)
        self.assertEqual(out+err,'')
        self.assertEqual(x['stage_display_generated_streams'],'none')
        self.assertEqual(x['stage_display_flushed_streams'],'none')
    def test_both_masks(self):
        _,x,_,_ = self.fake('{"type":"turn.started"}\n',stderr='hidden\n',suppress=True,activity=0)
        self.assertEqual(x['stage_display_generated_streams'],'both')
        self.assertEqual(x['stage_display_flushed_streams'],'both')
    def test_out_of_contract_uuid_and_usage_redacted(self):
        records=[{'type':'thread.started','thread_id':CANARY},
                 {'type':'turn.completed','usage':{'input_tokens':-1,'output_tokens':True,'cached_input_tokens':10**25}}]
        _,x,out,_ = self.fake(''.join(json.dumps(r)+'\n' for r in records))
        self.assertIn(CANARY,out)  # Existing display behavior is intentionally preserved.
        self.assertTrue(x['stdout_stage_type_seen'])
        self.assert_closed(x)
    def test_spoofed_text_never_classified(self):
        for text in ('codex turn started\n',json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'codex turn started\ncodex activity: 1 hidden tool/status events'}})+'\n'):
            with self.subTest(text=text):
                _,x,out,_ = self.fake(text)
                self.assertIn('codex turn started',out)
                self.assertFalse(x['stdout_stage_type_seen'])
                self.assertEqual(x['stage_display_generated_streams'],'none')
                self.assertEqual(x['stage_display_flushed_streams'],'none')
    def test_genuine_hidden_prefix_on_agent_text(self):
        text=json.dumps({'type':'hidden'})+'\n'+json.dumps({'item':{'type':'agent_message','text':CANARY}})+'\n'
        _,x,out,_=self.fake(text)
        self.assertIn('codex activity: 1 hidden tool/status events',out)
        self.assertFalse(x['stdout_stage_type_seen'])
        self.assertEqual(x['stage_display_flushed_streams'],'stdout')
        self.assert_closed(x)
    def test_writer_failure_preserves_exception(self):
        class Broken(io.StringIO):
            def write(self, text): raise OSError('synthetic write '+CANARY)
        stage=self.stage()
        with self.assertRaisesRegex(OSError,'synthetic write'):
            self.fake('{"type":"turn.started"}\n',sink=Broken(),stage=stage)
        x=stage.snapshot()
        self.assertEqual(x['terminal'],'collector_failure')
        self.assertEqual(x['stage_display_generated_streams'],'stdout')
        self.assertEqual(x['stage_display_flushed_streams'],'none')
        self.assert_closed(x)
    def test_flush_failure_preserves_exception(self):
        class Broken(io.StringIO):
            def flush(self): raise OSError('synthetic flush '+CANARY)
        stage=self.stage()
        with self.assertRaisesRegex(OSError,'synthetic flush'):
            self.fake('{"type":"turn.started"}\n',sink=Broken(),stage=stage)
        self.assertEqual(stage.snapshot()['stage_display_flushed_streams'],'none')
    def test_reader_failure_keeps_existing_result(self):
        class Broken(io.StringIO):
            def readline(self, *args): raise OSError('synthetic read '+CANARY)
        proc=FakeProcess(); proc.stdout=Broken()
        stage=self.stage(); errors=[]
        with mock.patch.object(M.subprocess,'Popen',return_value=proc), \
             mock.patch.object(M,'terminate_process_group'), \
             mock.patch.object(threading,'excepthook',side_effect=lambda event: errors.append(event.exc_type)):
            result=M.run_with_stream([],self.root,input_text=None,label='fake',heartbeat_seconds=1,
                deadline=M.EngineRuntimeDeadline('fake',1),stream_display=M.CodexStreamDisplay(engine_stage=stage),engine_stage=stage)
        self.assertEqual(result.returncode,0) # Existing reader exceptions do not propagate to the collector.
        self.assertEqual(errors,[OSError])
        self.assertEqual(stage.snapshot()['terminal'],'collector_failure')
        self.assertFalse(stage.snapshot()['stdout_text_read'])
    def test_reader_to_collector_gap_and_late_reader(self):
        entered=threading.Event(); release=threading.Event()
        class GapQueue(queue.Queue):
            def put(self,item,*args,**kwargs):
                if item[1] is not None:
                    entered.set()
                    if not release.wait(2): raise AssertionError('reader fixture gate expired')
                return super().put(item,*args,**kwargs)
            def get(self,*args,**kwargs):
                if not entered.wait(2): raise AssertionError('reader did not reach queue')
                raise RuntimeError('synthetic collector gap')
        stage=self.stage()
        try:
            with mock.patch.object(M.queue,'Queue',GapQueue):
                with self.assertRaisesRegex(RuntimeError,'collector gap'):
                    self.fake('{"type":"turn.started"}\n',stage=stage)
            before=stage.snapshot()
            self.assertTrue(before['stdout_text_read'])
            self.assertFalse(before['stdout_delivered_to_display'])
            self.assertEqual(before['terminal'],'collector_failure')
        finally: release.set()
        stage.seen('stdout_delivered_to_display')
        self.assertEqual(stage.snapshot(),before)
    def test_interrupt_retains_code_and_cleanup(self):
        stage=self.stage()
        with mock.patch.object(M.subprocess,'Popen',return_value=FakeProcess()), \
             mock.patch.object(M,'collect_streamed_process',side_effect=M.EngineInterrupted(143)), \
             mock.patch.object(M,'terminate_process_group') as cleanup:
            with self.assertRaises(M.EngineInterrupted) as caught:
                M.run_with_stream([],self.root,input_text=None,label='fake',heartbeat_seconds=1,stream_display=None,engine_stage=stage)
        self.assertEqual(caught.exception.code,143)
        self.assertEqual(cleanup.call_count,1)
        self.assertEqual(stage.snapshot()['terminal'],'interrupted')
    def test_launch_failure(self):
        stage=self.stage()
        with mock.patch.object(M.subprocess,'Popen',side_effect=OSError('synthetic launch')):
            with self.assertRaises(OSError):
                M.run_with_stream([],self.root,input_text=None,label='fake',heartbeat_seconds=1,stream_display=None,engine_stage=stage)
        self.assertFalse(stage.snapshot()['launch_returned'])
        self.assertEqual(stage.snapshot()['terminal'],'collector_failure')
    def test_concurrent_finalize_is_immutable(self):
        stage=self.stage(); barrier=threading.Barrier(9)
        def worker(index):
            barrier.wait(timeout=2)
            for _ in range(300):
                stage.seen('stdout_text_read'); stage.display('stdout')
                if index % 2: stage.finish('returned')
                stage.snapshot()
        threads=[threading.Thread(target=worker,args=(i,)) for i in range(8)]
        for t in threads: t.start()
        barrier.wait(timeout=2)
        for t in threads: t.join(timeout=2); self.assertFalse(t.is_alive())
        before=stage.snapshot(); stage.seen('stderr_text_read'); stage.finish('interrupted')
        self.assertEqual(stage.snapshot(),before)
        copy_snapshot=stage.snapshot(); copy_snapshot['terminal']='spoof'
        self.assertEqual(stage.snapshot(),before)
        self.assert_closed(before)
    def test_claim_once_unknown_until_finish(self):
        stage=self.stage()
        self.assertIsNone(stage.claim())
        self.assertIsNone(stage.snapshot())
        M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(list(self.output.iterdir()),[])
    def test_private_persistence_and_canary(self):
        stage=self.stage(); self.fake(json.dumps({'type':'thread.started','thread_id':CANARY})+'\n',stage=stage)
        M.persist_engine_stage(str(self.output),stage)
        file=self.output/'engine-stage.json'
        self.assertTrue(file.is_file())
        self.assertEqual(stat.S_IMODE(file.stat().st_mode),0o600)
        self.assertLessEqual(file.stat().st_size,4096)
        self.assertEqual(json.loads(file.read_text()),stage.snapshot())
        self.assertNotIn(CANARY,file.read_text())
        self.assertEqual([p.name for p in self.output.iterdir()],['engine-stage.json'])
    def test_stale_output_not_overwritten(self):
        file=self.output/'engine-stage.json'; file.write_text('retained')
        stage=self.stage(); stage.finish('returned'); M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(file.read_text(),'retained')
        self.assertFalse((self.output/'.engine-stage.partial').exists())
    def test_symlink_file_and_directory_rejected(self):
        outside=self.root/'outside'; outside.write_text('retained')
        (self.output/'engine-stage.json').symlink_to(outside)
        stage=self.stage(); stage.finish('returned'); M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(outside.read_text(),'retained')
        link=self.root/'link'; link.symlink_to(self.output,target_is_directory=True)
        (self.output/'engine-stage.json').unlink()
        M.persist_engine_stage(str(link),stage)
        self.assertEqual(list(self.output.iterdir()),[])
    def test_private_mode_required(self):
        self.output.chmod(0o755)
        stage=self.stage(); stage.finish('returned'); M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(list(self.output.iterdir()),[])
    def test_relative_dotdot_and_missing_directory_rejected(self):
        stage=self.stage(); stage.finish('returned')
        for target in ('relative',str(self.output/'..'/'output'),str(self.root/'missing')):
            M.persist_engine_stage(target,stage)
        self.assertEqual(list(self.output.iterdir()),[])
    def test_exclusive_temporary_symlink_rejected(self):
        outside=self.root/'outside'; outside.write_text('retained')
        (self.output/'.engine-stage.partial').symlink_to(outside)
        stage=self.stage(); stage.finish('returned'); M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(outside.read_text(),'retained')
        self.assertTrue((self.output/'.engine-stage.partial').is_symlink())
        self.assertFalse((self.output/'engine-stage.json').exists())
    def test_short_and_failed_write_cleanup(self):
        stage=self.stage(); stage.finish('returned')
        for failure in (0,OSError('synthetic disk '+CANARY)):
            with self.subTest(failure=type(failure).__name__):
                with mock.patch.object(M.os,'write',side_effect=failure if isinstance(failure,Exception) else None,return_value=failure):
                    M.persist_engine_stage(str(self.output),stage)
                self.assertEqual(list(self.output.iterdir()),[])
    def test_failed_publication_cleanup(self):
        stage=self.stage(); stage.finish('returned')
        with mock.patch.object(M.os,'link',side_effect=OSError('synthetic link')):
            M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(list(self.output.iterdir()),[])
    def test_snapshot_failure_is_diagnostic_only(self):
        stage=self.stage()
        with mock.patch.object(stage,'snapshot',side_effect=OSError('synthetic snapshot')):
            M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(list(self.output.iterdir()),[])
    def parse(self, extra=()):
        with mock.patch.object(sys,'argv',['fixture',*extra]): return M.parse_args()
    def test_default_and_opt_in_parser_contract(self):
        args=self.parse(); self.assertIsNone(args.engine_stage_dir)
        args=self.parse(['--engine-stage-dir',str(self.output),'--stream-engine-output'])
        self.assertEqual(args.engine_stage_dir,str(self.output))
    def test_carrier_survives_reviewer_clone(self):
        args=self.parse(); args._engine_stage=self.stage()
        reviewer=M.reviewer_args(args)[0]
        self.assertIs(reviewer._engine_stage,args._engine_stage)
    def test_main_wrapper_opt_in_off_and_unsupported(self):
        for extra in ([],['--engine-stage-dir',str(self.output)],['--engine-stage-dir',str(self.output),'--stream-engine-output','--engine','claude'],['--engine-stage-dir',str(self.output),'--stream-engine-output','--dry-run']):
            with self.subTest(extra=extra):
                args=self.parse(extra)
                with mock.patch.object(M,'parse_args',return_value=args),mock.patch.object(M,'main_with_args',return_value=7) as inner,mock.patch.object(M,'persist_engine_stage') as persist:
                    self.assertEqual(M.main_impl(),7)
                    self.assertFalse(hasattr(inner.call_args.args[0],'_engine_stage'))
                    persist.assert_not_called()
    def main_fixture(self, *, unavailable=False, fail_persistence=False):
        args=self.parse(['--engine-stage-dir',str(self.output),'--stream-engine-output','--status-output',str(self.root/'status.json'),'--json-output',str(self.root/'report.json')])
        report={'findings':[],'overall_correctness':'patch is correct','overall_explanation':'synthetic','overall_confidence':1.0}
        captured=types.SimpleNamespace(mixed=(),text='synthetic',images=())
        evidence=types.SimpleNamespace(prompt='',datasets=[],files=[])
        seen=[]
        def passes(args,reviewers,*remaining):
            seen.append(reviewers[0]._engine_stage)
            carrier=reviewers[0]._engine_stage; carrier.claim(); carrier.seen('launch_returned')
            carrier.finish('engine_timeout' if unavailable else 'returned')
            if unavailable:
                raise M.ReviewerUnavailable('synthetic unavailable',result=M.TimedOutEngineProcess([],124,'',''))
            return [('synthetic',types.SimpleNamespace(report=copy.deepcopy(report),complete=True))]
        replacements={'preflight_git':lambda:True,
          'capture_source_context_inputs':lambda *a:evidence,
          'require_image_engine':lambda *a:None,
          'parse_args':lambda:args,'repo_root':lambda:self.root,'prepare_output_paths':lambda *a:None,
          'choose_target':lambda *a:('diff',None),'current_branch':lambda *a:'synthetic','codex_config_keys':lambda *a:[],
          'codex_speed_override':lambda *a:None,'capture_evidence_inputs':lambda *a:evidence,
          'source_tree_snapshot':lambda *a:'same','build_bundle':lambda *a:captured,
          'prepare_review_prompts':lambda *a:['synthetic'],'verify_evidence':lambda *a:None,
          'verify_mixed_sources':lambda *a:None,'run_review_passes':passes,'print_report':lambda *a,**kw:None}
        with contextlib.ExitStack() as stack:
            for name,value in replacements.items(): stack.enter_context(mock.patch.object(M,name,value))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            if fail_persistence: stack.enter_context(mock.patch.object(M.os,'link',side_effect=OSError('synthetic persistence')))
            if unavailable:
                with self.assertRaises(M.ReviewerUnavailable) as caught: M.main_impl()
                self.assertEqual(caught.exception.returncode,124)
                self.assertTrue(caught.exception.timed_out)
                result=1
            else: result=M.main_impl()
        return result,json.loads((self.root/'status.json').read_text()),seen
    def test_main_success_envelope_unchanged(self):
        result,status,seen=self.main_fixture()
        self.assertEqual(result,0)
        self.assertEqual(status,{'schema_version':1,'status':'scoped-clean','exit_code':0,'engine':'codex','report_produced':True,'reason':None,'reviewer_exit_code':None,'timed_out':False})
        self.assertTrue((self.root/'report.json').exists())
        self.assertEqual(json.loads((self.output/'engine-stage.json').read_text()),seen[0].snapshot())
    def test_main_unavailable_envelope_unchanged(self):
        result,status,_=self.main_fixture(unavailable=True)
        self.assertEqual(status,{'schema_version':1,'status':'reviewer_unavailable','exit_code':1,'engine':'codex','report_produced':False,'reason':'engine_failed','reviewer_exit_code':124,'timed_out':True})
        self.assertFalse((self.root/'report.json').exists())
    def test_main_persistence_failure_cannot_mask_failure(self):
        _,status,_=self.main_fixture(unavailable=True,fail_persistence=True)
        self.assertTrue(status['timed_out'])
        self.assertFalse((self.output/'engine-stage.json').exists())
    def test_main_persistence_failure_cannot_change_success(self):
        result,status,_=self.main_fixture(fail_persistence=True)
        self.assertEqual(result,0)
        self.assertEqual(status['status'],'scoped-clean')
    def test_codex_real_carrier_first_attempt_only(self):
        args=self.parse(['--stream-engine-output','--model','synthetic-primary'])
        args=M.reviewer_args(args)[0]; args.fallback_model='synthetic-fallback'
        carrier=M.EngineStage(); args._engine_stage=carrier
        seen=[]
        def command(args,repo,review_root,runtime_root,schema,output,model,**kwargs):
            seen.append(model)
            script='raise SystemExit(3)' if len(seen)==1 else 'print(\'{"type":"turn.started"}\')'
            return [sys.executable,'-I','-S','-B','-c',script]
        def launch(*a,**kw):
            proc=REAL_POPEN(*a,**kw); PROCESSES.append(proc); return proc
        stubs={'ensure_codex_isolation_supported':lambda *a:None,'safe_temp_root':lambda *a,**kw:self.root,
               'load_codex_inference_route':lambda *a:None,'prepare_codex_inference_config':lambda *a:[],
               'stage_codex_auth_helper':lambda *a:[],'prepare_codex_runtime_auth':lambda *a:False,
               'codex_command':command,'codex_model_access_failure':lambda *a:True,
               'codex_runtime_env':lambda *a,**kw:{'HOME':str(self.home),'TMPDIR':str(self.home),'PATH':os.environ.get('PATH', os.defpath),'LANG':'C.UTF-8'}}
        args.engine_timeout_seconds=1
        before=set(self.root.iterdir())
        with contextlib.ExitStack() as stack:
            for name,value in stubs.items(): stack.enter_context(mock.patch.object(M,name,value))
            stack.enter_context(mock.patch.object(M.subprocess,'Popen',side_effect=launch))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            result=M.run_codex(args,self.root,'synthetic input')
        self.assertEqual(result,'{"type":"turn.started"}\n')
        self.assertEqual(seen,['synthetic-primary','synthetic-fallback'])
        self.assertEqual(carrier.snapshot()['terminal'],'returned')
        self.assertTrue(carrier.snapshot()['launch_returned'])
        self.assertFalse(carrier.snapshot()['stdout_text_read'])
        self.assertFalse(carrier.snapshot()['stdout_stage_type_seen'])
        self.assertEqual(set(self.root.iterdir()),before)
        for proc in PROCESSES[-2:]:
            self.assertIsNotNone(proc.poll())
            with self.assertRaises(ProcessLookupError): os.killpg(proc.pid,0)
    def test_fifo_destinations_do_not_block(self):
        stage=self.stage(); stage.finish('returned')
        for name in ('.engine-stage.partial','engine-stage.json'):
            fifo=self.output/name; os.mkfifo(fifo,0o600)
            began=time.monotonic(); M.persist_engine_stage(str(self.output),stage)
            self.assertLess(time.monotonic()-began,1)
            self.assertTrue(stat.S_ISFIFO(fifo.lstat().st_mode))
            fifo.unlink()
        self.assertEqual(list(self.output.iterdir()),[])
    def test_short_real_write_leaves_no_partial(self):
        stage=self.stage(); stage.finish('returned'); real_write=os.write
        with mock.patch.object(M.os,'write',side_effect=lambda fd,data:real_write(fd,data[:4])):
            M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(list(self.output.iterdir()),[])
    @unittest.skipUnless(Path("/proc/self/fd").is_dir(), "requires procfs")
    def test_persistence_fd_settled_on_failure(self):
        stage=self.stage(); stage.finish('returned')
        before=set(Path('/proc/self/fd').iterdir())
        with mock.patch.object(M.os,'link',side_effect=OSError('synthetic publication')):
            M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(set(Path('/proc/self/fd').iterdir()),before)
    def test_persistence_bounds(self):
        stage=self.stage(); stage.finish('returned')
        M.persist_engine_stage('/'+'x'*4096,stage)
        M.persist_engine_stage('/'+'/'.join(['x']*65),stage)
        with mock.patch.object(stage,'snapshot',return_value={'synthetic':'x'*4096}):
            M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(list(self.output.iterdir()),[])
    def test_foreign_owned_directory_refused(self):
        stage=self.stage(); stage.finish('returned'); real_fstat=os.fstat
        def changed(fd):
            info=real_fstat(fd)
            if (info.st_dev,info.st_ino)==(self.output.stat().st_dev,self.output.stat().st_ino):
                values=list(info); values[4]=os.geteuid()+17; return os.stat_result(values)
            return info
        with mock.patch.object(M.os,'fstat',side_effect=changed):
            M.persist_engine_stage(str(self.output),stage)
        self.assertEqual(list(self.output.iterdir()),[])
    def test_complete_snapshot_is_independent_copy(self):
        stage=self.stage(); stage.finish('returned'); first=stage.snapshot()
        first['stdout_text_read']=True
        self.assertFalse(stage.snapshot()['stdout_text_read'])
    def test_main_interrupt_code_unchanged(self):
        with mock.patch.object(M,'main_impl',side_effect=M.EngineInterrupted(143)):
            self.assertEqual(M.main(),143)

    def test_short_display_write_is_not_flushed_stage(self):
        class Short(io.StringIO):
            def write(self,text): return super().write(text[:1])
        result,x,out,_=self.fake('{"type":"turn.started"}\n',sink=Short())
        self.assertEqual(result.returncode,0)
        self.assertEqual(out,'c')
        self.assertEqual(x['stage_display_generated_streams'],'stdout')
        self.assertEqual(x['stage_display_flushed_streams'],'none')
    def test_recognized_branch_before_render_failure(self):
        stage=self.stage()
        with mock.patch.object(M.CodexStreamDisplay,'visible',side_effect=OSError('synthetic render')):
            with self.assertRaisesRegex(OSError,'synthetic render'):
                self.fake('{"type":"turn.started"}\n',stage=stage)
        x=stage.snapshot()
        self.assertTrue(x['stdout_stage_type_seen'])
        self.assertEqual(x['stage_display_generated_streams'],'none')
        self.assertEqual(x['terminal'],'collector_failure')

    def test_stage_directory_cannot_mutate_reviewed_repository(self):
        args=self.parse(['--engine-stage-dir',str(self.output)])
        with self.assertRaisesRegex(SystemExit,'--engine-stage-dir must point outside'):
            M.prepare_output_paths(args,self.root)
        self.assertEqual(list(self.output.iterdir()),[])
    def test_stage_directory_alias_into_repository_refused(self):
        alias=self.root/'alias'; alias.symlink_to(self.home,target_is_directory=True)
        args=self.parse(['--engine-stage-dir',str(alias)])
        with self.assertRaisesRegex(SystemExit,'--engine-stage-dir must point outside'):
            M.prepare_output_paths(args,self.home)
    def test_stage_directory_outside_repository_allowed(self):
        args=self.parse(['--engine-stage-dir',str(self.output)])
        M.prepare_output_paths(args,self.home)

    def test_stage_directory_cannot_alias_report_destinations(self):
        for option in ('--output', '--json-output', '--status-output'):
            with self.subTest(option=option):
                args=self.parse(['--engine-stage-dir',str(self.output),option,str(self.output)])
                before=vars(args).copy()
                with self.assertRaisesRegex(SystemExit,'--engine-stage-dir must use a different path'):
                    M.prepare_output_paths(args,self.home)
                self.assertEqual(vars(args),before)
                self.assertEqual(list(self.output.iterdir()),[])

    def test_stage_path_spelling_is_not_normalized_by_output_preflight(self):
        for value in ('relative', str(self.root / '..' / 'output')):
            with self.subTest(value=value):
                args=self.parse(['--engine-stage-dir',value])
                M.prepare_output_paths(args,self.home)
                self.assertEqual(args.engine_stage_dir,value)

    def test_stream_interruption_preserves_caller_stdout(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                stage = self.stage() if enabled else None
                interrupted = M.EngineInterrupted(143)
                def collect(*args, **kwargs):
                    kwargs['stdout_parts'].extend(['first\n', 'last fragment'])
                    self.assertIs(kwargs['engine_stage'], stage)
                    raise interrupted
                with mock.patch.object(M.subprocess, 'Popen', return_value=FakeProcess()), \
                        mock.patch.object(M, 'collect_streamed_process', side_effect=collect), \
                        mock.patch.object(M, 'terminate_process_group'), \
                        self.assertRaises(M.EngineInterrupted) as caught:
                    M.run_with_stream([], self.root, input_text=None, label='fixture',
                        heartbeat_seconds=1, stream_display=None, engine_stage=stage)
                self.assertIs(caught.exception, interrupted)
                self.assertEqual(interrupted.stdout, 'first\nlast fragment')
                if stage:
                    self.assertEqual(stage.snapshot()['terminal'], 'interrupted')

    def test_buffered_and_streamed_interruption_preserve_usage(self):
        event = json.dumps({'type': 'turn.completed', 'usage': {
            'input_tokens': 100, 'cached_input_tokens': 20,
            'output_tokens': 30, 'reasoning_output_tokens': 10}})
        for streaming in (False, True):
            for enabled in (False, True):
                with self.subTest(streaming=streaming, enabled=enabled):
                    stage = self.stage() if enabled else None
                    def interrupt(*args):
                        raise M.EngineInterrupted(130)
                    script = f'import time; print({event!r}, flush=True); time.sleep(5)'
                    with mock.patch.object(M, 'emit_heartbeat', side_effect=interrupt), \
                            self.assertRaises(M.EngineInterrupted) as caught:
                        M.run_with_heartbeat([sys.executable, '-I', '-S', '-B', '-c', script],
                            self.root, label='synthetic', heartbeat_seconds=.2,
                            max_runtime_seconds=2, stream_output=streaming,
                            stream_display=interrupt, engine_stage=stage,
                            env={'HOME': str(self.home), 'TMPDIR': str(self.home),
                                 'PATH': os.environ.get('PATH', os.defpath)})
                    args = types.SimpleNamespace()
                    M.record_codex_usage(args, caught.exception.stdout, completed=False)
                    usage = M.review_usage_summary(args)
                    self.assertEqual(usage['attempts'], 1)
                    self.assertEqual(usage['tokens']['input_tokens'], 100)
                    self.assertFalse(usage['complete'])
                    if stage:
                        self.assertEqual(stage.snapshot()['terminal'], 'interrupted') if streaming else self.assertIsNone(stage.snapshot())

    def test_codex_usage_finally_records_interrupted_retry_once(self):
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                args = M.reviewer_args(self.parse(['--model', 'synthetic-primary']))[0]
                args.stream_engine_output = streaming
                args.fallback_model = 'synthetic-fallback'
                args._engine_stage = M.EngineStage()
                usage = json.dumps({'type': 'turn.completed', 'usage': {
                    'input_tokens': 100, 'cached_input_tokens': 20, 'output_tokens': 30, 'reasoning_output_tokens': 10}})
                interrupted = M.EngineInterrupted(130)
                interrupted.stdout = usage
                seen = []
                def heartbeat(*a, **kw):
                    seen.append(kw['engine_stage'])
                    if len(seen) == 1:
                        return subprocess.CompletedProcess([], 3, usage, 'unavailable')
                    raise interrupted
                stubs = {
                    'ensure_codex_isolation_supported': lambda *a: None,
                    'safe_temp_root': lambda *a, **kw: self.root,
                    'load_codex_inference_route': lambda *a: None,
                    'prepare_codex_inference_config': lambda *a: [],
                    'stage_codex_auth_helper': lambda *a: [],
                    'prepare_codex_runtime_auth': lambda *a: False,
                    'codex_command': lambda *a, **kw: ['synthetic'],
                    'codex_runtime_env': lambda *a, **kw: {},
                    'codex_model_access_failure': lambda *a: True,
                    'run_with_heartbeat': heartbeat,
                }
                before = set(self.root.iterdir())
                with contextlib.ExitStack() as stack:
                    for name, value in stubs.items():
                        stack.enter_context(mock.patch.object(M, name, value))
                    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    with self.assertRaises(M.EngineInterrupted) as caught:
                        M.run_codex(args, self.root, 'synthetic prompt')
                self.assertIs(caught.exception, interrupted)
                summary = M.review_usage_summary(args)
                self.assertEqual(summary['attempts'], 2)
                self.assertEqual(summary['partial_attempts'], 2)
                self.assertEqual(summary['tokens']['input_tokens'], 200)
                self.assertFalse(summary['complete'])
                self.assertEqual(seen, [args._engine_stage if streaming else None, None])
                self.assertEqual(set(self.root.iterdir()), before)

    def test_current_main_preserves_preflight_and_structured_completion(self):
        for outcome in ('incomplete', 'interrupted', 'later_failure'):
            with self.subTest(outcome=outcome):
                directory = self.root / outcome
                directory.mkdir(mode=0o700)
                stage_dir = directory / 'stage'
                stage_dir.mkdir(mode=0o700)
                args = self.parse(['--engine-stage-dir', str(stage_dir), '--stream-engine-output',
                    '--json-output', str(directory / 'report.json'),
                    '--status-output', str(directory / 'status.json')])
                evidence = types.SimpleNamespace(prompt='', datasets=[], files=[])
                captured = types.SimpleNamespace(mixed=(), text='synthetic', images=())
                calls = []
                report = {'findings': [], 'overall_correctness': 'patch is correct',
                          'overall_explanation': 'synthetic', 'overall_confidence': 1.0}
                def passes(args, reviewers, *unused):
                    carrier = reviewers[0]._engine_stage
                    self.assertIs(carrier, args._engine_stage)
                    carrier.claim(); carrier.finish('returned')
                    M.record_codex_usage(args, json.dumps({'type': 'turn.completed',
                        'usage': {'input_tokens': 100, 'cached_input_tokens': 20, 'output_tokens': 30, 'reasoning_output_tokens': 10}}))
                    if outcome == 'interrupted':
                        raise M.EngineInterrupted(130)
                    if outcome == 'later_failure':
                        M.record_codex_usage(args, '', completed=False)
                        raise M.ReviewerUnavailable('synthetic later failure')
                    return [('synthetic', M.ReviewResult(report, False))]
                def source_context(*unused):
                    calls.append('source-context'); return evidence
                stubs = {'parse_args': lambda: args, 'preflight_git': lambda: calls.append('git') or True,
                    'repo_root': lambda: self.home, 'choose_target': lambda *a: ('branch', 'base'),
                    'current_branch': lambda *a: 'synthetic', 'capture_evidence_inputs': lambda *a: evidence,
                    'source_tree_snapshot': lambda *a: 'same', 'build_bundle': lambda *a: captured,
                    'require_image_engine': lambda *a: calls.append('images'),
                    'capture_source_context_inputs': source_context,
                    'prepare_review_prompts': lambda *a: ['synthetic'],
                    'check_review_plan': lambda *a: calls.append('plan'),
                    'verify_evidence': lambda *a: None, 'verify_mixed_sources': lambda *a: None,
                    'run_review_passes': passes, 'print_report': lambda *a, **kw: None}
                out = io.StringIO()
                with contextlib.ExitStack() as stack:
                    for name, value in stubs.items():
                        stack.enter_context(mock.patch.object(M, name, value))
                    stack.enter_context(contextlib.redirect_stdout(out))
                    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    if outcome == 'incomplete':
                        self.assertEqual(M.main_impl(), 2)
                    else:
                        error = M.EngineInterrupted if outcome == 'interrupted' else M.ReviewerUnavailable
                        with self.assertRaises(error):
                            M.main_impl()
                self.assertEqual(calls, ['git', 'images', 'source-context', 'plan'])
                self.assertIn('review usage:', out.getvalue())
                sidecar = json.loads((stage_dir / 'engine-stage.json').read_text())
                self.assertEqual(sidecar['terminal'], 'returned')
                self.assertIs(sidecar['acceptance'], False)
                self.assertEqual((directory / 'report.json').exists(), outcome == 'incomplete')
                if outcome == 'interrupted':
                    self.assertFalse((directory / 'status.json').exists())
                else:
                    status = json.loads((directory / 'status.json').read_text())
                    self.assertEqual(status['status'], 'incomplete' if outcome == 'incomplete' else 'reviewer_unavailable')
                    self.assertEqual(status['usage']['attempts'], 1 if outcome == 'incomplete' else 2)

    def test_git_preflight_refusal_has_no_observed_stage(self):
        args = self.parse(['--engine-stage-dir', str(self.output), '--stream-engine-output'])
        with mock.patch.object(M, 'parse_args', return_value=args), \
                mock.patch.object(M, 'preflight_git', return_value=False), \
                mock.patch.object(M, 'repo_root') as repo:
            self.assertEqual(M.main_impl(), 2)
        repo.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_complete_cli_with_explicit_local_synthetic_producer(self):
        if os.name != 'posix':
            self.skipTest('synthetic executable requires POSIX')
        repo = self.root / 'repo'
        repo.mkdir(mode=0o700)
        git_fixture = runpy.run_path(str(SOURCE.with_name('test-review-harness.py')))
        git_roots = git_fixture['fixture_git_roots'](repo)
        git_bin = git_fixture['fixture_git_binary'](git_roots)
        git_path = git_fixture['fixture_git_path'](
            git_roots, git_bin, os.environ.get('PATH', os.defpath))
        env = {'HOME': str(self.home), 'TMPDIR': str(self.home),
               'PATH': git_path, 'LANG': 'C.UTF-8',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
               'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_LAZY_FETCH': '1'}
        for args in (['init', '-q'], ['add', 'source.txt']):
            (repo / 'source.txt').write_text('synthetic change\n')
            subprocess.run(['git', *args], cwd=repo, env=env, check=True,
                           capture_output=True, timeout=5)
        producer = self.root / 'synthetic-producer'
        # The only engine executable is this owned local fixture. Its Python
        # interpreter disables site loading, inherited paths and bytecode writes.
        producer.write_text('#!/bin/sh\n'
            f"'''exec' {shlex.quote(sys.executable)} -I -S -B \"$0\" \"$@\"\n"
            "' '''\n" + '''
import json, pathlib, sys
if '--version' in sys.argv:
    print('codex-cli 0.0.0-test')
else:
    output = pathlib.Path(sys.argv[sys.argv.index('--output-last-message') + 1])
    output.write_text(json.dumps({'findings': [], 'overall_correctness': 'patch is correct',
        'overall_explanation': 'synthetic', 'overall_confidence': 1.0,
        'review_completion': 'complete'}))
    print(json.dumps({'type': 'turn.started'}))
    print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 10, 'cached_input_tokens': 2, 'output_tokens': 3, 'reasoning_output_tokens': 1}}))
''')
        producer.chmod(0o700)
        result = subprocess.run([sys.executable, '-I', '-S', '-B', str(SOURCE),
            '--mode', 'local', '--engine', 'codex', '--model', 'synthetic',
            '--codex-bin', str(producer), '--stream-engine-output',
            '--engine-timeout-seconds', '3', '--engine-stage-dir', str(self.output),
            '--json-output', str(self.root / 'report.json'),
            '--status-output', str(self.root / 'status.json')],
            cwd=repo, env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads((self.root / 'report.json').read_text())
        self.assertEqual(report['review_status'], 'scoped-clean')
        self.assertEqual(report['usage']['attempts'], 1)
        self.assertEqual(report['usage']['tokens']['input_tokens'], 10)
        sidecar = json.loads((self.output / 'engine-stage.json').read_text())
        self.assertTrue(sidecar['stdout_stage_type_seen'])
        self.assertEqual(sidecar['terminal'], 'returned')
        self.assertEqual(sidecar['stage_display_flushed_streams'], 'none')
        self.assert_closed(sidecar)

    def test_post_launch_cancellation_settles_acquired_pipes_before_snapshot(self):
        for cancelled in (M.EngineInterrupted(143), KeyboardInterrupt()):
            with self.subTest(cancellation=type(cancelled).__name__):
                stage = self.stage()
                owned = []
                observed = []
                original_finish = stage.finish
                def launch(*args, **kwargs):
                    process = REAL_POPEN(*args, **kwargs)
                    owned.append(process)
                    PROCESSES.append(process)
                    return process
                def finish(terminal):
                    process = owned[0]
                    observed.append((process.poll() is not None,
                        all(pipe is None or pipe.closed for pipe in
                            (process.stdin, process.stdout, process.stderr)),
                        not M._OWNED_PROCESSES))
                    original_finish(terminal)
                with mock.patch.object(M.subprocess, 'Popen', side_effect=launch), \
                        mock.patch.object(stage, 'seen', side_effect=cancelled), \
                        mock.patch.object(stage, 'finish', side_effect=finish), \
                        self.assertRaises(type(cancelled)) as caught:
                    M.run_with_stream(
                        [sys.executable, '-I', '-S', '-B', '-c', 'import time; time.sleep(5)'],
                        self.root, input_text='synthetic', label='synthetic',
                        heartbeat_seconds=1, deadline=M.EngineRuntimeDeadline('synthetic', 1),
                        stream_display=None, engine_stage=stage,
                        env={'HOME': str(self.home), 'TMPDIR': str(self.home),
                             'PATH': os.environ.get('PATH', os.defpath)})
                self.assertIs(caught.exception, cancelled)
                self.assertEqual(observed, [(True, True, True)])
                self.assertEqual(stage.snapshot()['terminal'], 'interrupted')
                with self.assertRaises(ProcessLookupError):
                    os.killpg(owned[0].pid, 0)

    def test_cleanup_metadata_failure_preserves_primary_and_closes_descriptors(self):
        for primary in (None, RuntimeError('primary'), M.EngineInterrupted(143)):
            with self.subTest(primary=type(primary).__name__):
                output = self.output / type(primary).__name__
                output.mkdir(mode=0o700)
                stage = self.stage(); stage.finish('returned')
                args = types.SimpleNamespace(engine_stage_dir=str(output), engine='codex',
                    stream_engine_output=True, dry_run=False)
                original_open, original_close, original_fstat = os.open, os.close, os.fstat
                acquired, released = [], []
                file_fd = None
                file_metadata_reads = 0
                def opening(*args, **kwargs):
                    nonlocal file_fd
                    fd = original_open(*args, **kwargs)
                    info = original_fstat(fd)
                    acquired.append((fd, info.st_dev, info.st_ino))
                    if args[0] == '.engine-stage.partial':
                        file_fd = fd
                    return fd
                def closing(fd):
                    info = original_fstat(fd)
                    released.append((fd, info.st_dev, info.st_ino))
                    original_close(fd)
                def metadata(fd):
                    nonlocal file_metadata_reads
                    info = original_fstat(fd)
                    if fd == file_fd:
                        file_metadata_reads += 1
                        if file_metadata_reads == 2:
                            raise MemoryError('synthetic cleanup metadata failure')
                    return info
                def body(_args):
                    if primary is not None:
                        raise primary
                    return 47
                with mock.patch.object(M, 'parse_args', return_value=args), \
                        mock.patch.object(M, 'EngineStage', return_value=stage), \
                        mock.patch.object(M, 'main_with_args', side_effect=body), \
                        mock.patch.object(M.os, 'open', side_effect=opening), \
                        mock.patch.object(M.os, 'close', side_effect=closing), \
                        mock.patch.object(M.os, 'fstat', side_effect=metadata):
                    if primary is None:
                        self.assertEqual(M.main_impl(), 47)
                    else:
                        with self.assertRaises(type(primary)) as caught:
                            M.main_impl()
                        self.assertIs(caught.exception, primary)
                self.assertEqual(file_metadata_reads, 2)
                self.assertCountEqual(acquired, released)
                self.assertEqual(sorted(path.name for path in output.iterdir()),
                    ['.engine-stage.partial', 'engine-stage.json'])
                self.assertEqual((output / '.engine-stage.partial').stat().st_ino,
                    (output / 'engine-stage.json').stat().st_ino)
                self.assertEqual(json.loads((output / 'engine-stage.json').read_text()), stage.snapshot())

    def test_child_descriptor_survives_parent_close_fault_without_reclosing_reused_number(self):
        for fault in (MemoryError('after parent close'), M.EngineInterrupted(143)):
            with self.subTest(fault=type(fault).__name__):
                stage = self.stage(); stage.finish('returned')
                fixture = self.root / type(fault).__name__
                fixture.write_bytes(b'synthetic fixture handle')
                original_open, original_close, original_fstat = os.open, os.close, os.fstat
                acquired, released = [], []
                sentinel = None
                sentinel_identity = None
                def identity(fd):
                    info = original_fstat(fd)
                    return (fd, info.st_dev, info.st_ino)
                def opening(*args, **kwargs):
                    fd = original_open(*args, **kwargs)
                    acquired.append(identity(fd))
                    return fd
                def closing(fd):
                    nonlocal sentinel, sentinel_identity
                    released.append(identity(fd))
                    original_close(fd)
                    if sentinel is None:
                        sentinel = original_open(fixture, os.O_RDONLY)
                        sentinel_identity = identity(sentinel)
                        self.assertEqual(sentinel, fd)
                        raise fault
                try:
                    with mock.patch.object(M.os, 'open', side_effect=opening), \
                            mock.patch.object(M.os, 'close', side_effect=closing):
                        if isinstance(fault, M.EngineInterrupted):
                            with self.assertRaises(M.EngineInterrupted) as caught:
                                M.persist_engine_stage(str(self.output), stage)
                            self.assertIs(caught.exception, fault)
                        else:
                            M.persist_engine_stage(str(self.output), stage)
                    self.assertEqual(len(acquired), 2)
                    self.assertCountEqual(acquired, released)
                    self.assertEqual(identity(sentinel), sentinel_identity)
                    self.assertEqual(list(self.output.iterdir()), [])
                finally:
                    if sentinel is not None:
                        original_close(sentinel)


if __name__ == "__main__":
    unittest.main()
