# Service and Executor Templates

## Service Interface (Protocol)

```python
# client/api/user_service_i.py
from typing import Protocol
from client.dto.response import Response, SingleResponse, MultiResponse
from client.dto.command.user_add_cmd import UserAddCmd
from client.dto.query.user_list_qry import UserListQry
from client.dto.co.user_co import UserCO

class UserServiceI(Protocol):
    def add_user(self, cmd: UserAddCmd) -> Response: ...
    def get_user(self, user_id: str) -> SingleResponse[UserCO]: ...
    def list_users(self, qry: UserListQry) -> MultiResponse[UserCO]: ...
```

## Command Executor

```python
# application/command/user_add_cmd_exe.py
from client.dto.command.user_add_cmd import UserAddCmd
from client.dto.response import Response
from domain.gateway.user_gateway import UserGateway
from domain.user.entity import User

class UserAddCmdExe:
    def __init__(self, user_gateway: UserGateway):
        self.user_gateway = user_gateway
    
    def execute(self, cmd: UserAddCmd) -> Response:
        if not cmd.user_co.email:
            return Response.build_failure("PARAM_ERROR", "Email cannot be empty")
        
        if self.user_gateway.exists_by_email(cmd.user_co.email):
            return Response.build_failure("EMAIL_EXISTS", "Email already exists")
        
        user = User(name=cmd.user_co.name, email=cmd.user_co.email)
        self.user_gateway.save(user)
        return Response.build_success()
```

## Query Executor

```python
# application/query/user_list_qry_exe.py
from client.dto.query.user_list_qry import UserListQry
from client.dto.response import MultiResponse
from client.dto.co.user_co import UserCO
from domain.gateway.user_gateway import UserGateway
from infrastructure.convertor.user_convertor import UserConvertor

class UserListQryExe:
    def __init__(self, user_gateway: UserGateway, convertor: UserConvertor):
        self.user_gateway = user_gateway
        self.convertor = convertor
    
    def execute(self, qry: UserListQry) -> MultiResponse[UserCO]:
        users = self.user_gateway.list_by_condition(
            qry.keyword, qry.page_index, qry.page_size
        )
        user_cos = [self.convertor.to_client_object(u) for u in users]
        return MultiResponse.of(user_cos)
```

## Service Implementation

```python
# application/service/user_service.py
from functools import wraps
import logging
from client.dto.response import Response

logger = logging.getLogger(__name__)

def catch_and_log(func):
    """Exception catching decorator (equivalent to Java @CatchAndLog)"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            logger.exception(f"Error in {func.__name__}: {e}")
            return Response.build_failure("SYSTEM_ERROR", str(e))
    return wrapper

class UserService:
    def __init__(self, user_add_cmd_exe, user_list_qry_exe):
        self.user_add_cmd_exe = user_add_cmd_exe
        self.user_list_qry_exe = user_list_qry_exe
    
    @catch_and_log
    def add_user(self, cmd):
        return self.user_add_cmd_exe.execute(cmd)
    
    @catch_and_log
    def list_users(self, qry):
        return self.user_list_qry_exe.execute(qry)
```
