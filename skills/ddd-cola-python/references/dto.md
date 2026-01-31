# DTO Templates

## Response Base Classes

```python
# client/dto/response.py
from dataclasses import dataclass, field
from typing import TypeVar, Generic, List, Optional

T = TypeVar('T')

@dataclass
class Response:
    success: bool = True
    err_code: Optional[str] = None
    err_message: Optional[str] = None
    
    @classmethod
    def build_success(cls) -> "Response":
        return cls(success=True)
    
    @classmethod
    def build_failure(cls, err_code: str, err_message: str) -> "Response":
        return cls(success=False, err_code=err_code, err_message=err_message)

@dataclass
class SingleResponse(Response, Generic[T]):
    data: Optional[T] = None
    
    @classmethod
    def of(cls, data: T) -> "SingleResponse[T]":
        return cls(success=True, data=data)

@dataclass
class MultiResponse(Response, Generic[T]):
    data: List[T] = field(default_factory=list)
    
    @classmethod
    def of(cls, data: List[T]) -> "MultiResponse[T]":
        return cls(success=True, data=data)

@dataclass
class PageResponse(Response, Generic[T]):
    data: List[T] = field(default_factory=list)
    total_count: int = 0
    page_size: int = 10
    page_index: int = 1
```

## Command

```python
# client/dto/command/user_add_cmd.py
from dataclasses import dataclass
from client.dto.co.user_co import UserCO

@dataclass
class UserAddCmd:
    user_co: UserCO
```

## Query

```python
# client/dto/query/user_list_qry.py
from dataclasses import dataclass
from typing import Optional

@dataclass
class UserListQry:
    keyword: Optional[str] = None
    page_index: int = 1
    page_size: int = 10
```

## Client Object (CO)

```python
# client/dto/co/user_co.py
from dataclasses import dataclass
from typing import Optional

@dataclass
class UserCO:
    id: Optional[str] = None
    name: str = ""
    email: str = ""
    status: str = "active"
```
